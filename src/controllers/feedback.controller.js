import ManualFeedback from '../models/ManualFeedback.js'
import Essay from '../models/Essay.js'
import AIAnalysis from '../models/AIAnalysis.js'
import Class from '../models/Class.js'
import ErrorResponse from '../utils/ErrorResponse.js'
import asyncHandler from '../utils/asyncHandler.js'
import {
  canAccessEssay,
  resolveEssayClassId,
  buildTeacherEssayScopeFromClassIds,
} from '../utils/essayAccess.js'

/**
 * TEACH-01 / LG-02: grading is allowed only for an essay that belongs to an
 * active class taught by this teacher. Assignment ownership alone is not
 * enough, and archived classes are read-only.
 */
async function assertCanGradeEssay(user, essay) {
  if (!essay) throw new ErrorResponse('Essay not found', 404)

  if (essay.status === 'draft') {
    throw new ErrorResponse(
      'Cannot grade an essay that has not been submitted',
      409,
      'ESSAY_NOT_SUBMITTED',
    )
  }

  const classId = await resolveEssayClassId(essay)
  if (!classId) {
    throw new ErrorResponse('Not authorized to grade this essay', 403)
  }

  const cls = await Class.findOne({
    _id: classId,
    teacher: user._id,
    students: essay.student,
  }).select('status').lean()

  if (!cls) {
    throw new ErrorResponse('Not authorized to grade this essay', 403)
  }

  if (cls.status !== 'active') {
    throw new ErrorResponse(
      'Feedback can only be graded in an active class',
      409,
      'CLASS_NOT_ACTIVE',
    )
  }
}

/**
 * Helper: normalise the four teacher rubric scores.
 * Missing criteria fall back to the previous score, then to the neutral 5.
 * They must never be treated as 0, otherwise a partially filled rubric
 * produces a fake failing overall score.
 */
const TEACHER_SCORE_KEYS = ['grammar', 'vocabulary', 'coherence', 'complexity']
const DEFAULT_TEACHER_SCORE = 5

function mergeTeacherScores(base, incoming) {
  const baseScores = typeof base?.toObject === 'function' ? base.toObject() : (base || {})
  const merged = { ...baseScores }

  for (const key of TEACHER_SCORE_KEYS) {
    const candidate = incoming?.[key]
    if (candidate !== undefined && candidate !== null && Number.isFinite(Number(candidate))) {
      merged[key] = Number(candidate)
    }
  }

  for (const key of TEACHER_SCORE_KEYS) {
    if (!Number.isFinite(Number(merged[key]))) {
      merged[key] = DEFAULT_TEACHER_SCORE
    }
  }

  return merged
}

/**
 * Helper: compute overall score from teacher's 4 manual scores (each 1-10).
 * Returns a number rounded to 1 decimal.
 */
function computeTeacherOverallScore(scores) {
  const { grammar, vocabulary, coherence, complexity } = mergeTeacherScores({}, scores)
  return Math.round(((grammar + vocabulary + coherence + complexity) / 4) * 10) / 10
}

/**
 * Helper: sync teacher-adjusted scores back to AIAnalysis overallScore so the
 * submissions list shows the teacher's score instead of the raw AI score.
 * Creates an AIAnalysis stub if one does not yet exist for the essay.
 */
async function syncTeacherScoresToAnalysis(essayId, scores) {
  if (!scores) return
  try {
    const normalizedScores = mergeTeacherScores({}, scores)
    const overallScore = computeTeacherOverallScore(normalizedScores)

    let analysis = await AIAnalysis.findOne({ essay: essayId })
    if (!analysis) {
      // Create a minimal AIAnalysis so the score can be stored and returned
      analysis = new AIAnalysis({
        essay: essayId,
        overallScore,
        isTeacherGraded: true,
        scores: {
          grammarAccuracy: normalizedScores.grammar,
          coherence: normalizedScores.coherence,
          complexityIndex: normalizedScores.complexity,
          lexicalResource: normalizedScores.vocabulary,
          // vocabularyDiversity is TTR (0-1), keep default 0 to avoid constraint violation
          vocabularyDiversity: 0,
        },
      })
    } else {
      analysis.overallScore = overallScore
      analysis.isTeacherGraded = true
      if (!analysis.scores) analysis.scores = {}
      analysis.scores.grammarAccuracy = normalizedScores.grammar
      analysis.scores.coherence = normalizedScores.coherence
      analysis.scores.complexityIndex = normalizedScores.complexity
      analysis.scores.lexicalResource = normalizedScores.vocabulary
    }

    await analysis.save()
  } catch (err) {
    console.error('Error syncing teacher scores to AIAnalysis:', err.message)
  }
}

/**
 * @desc    Get essays pending teacher feedback
 * @route   GET /api/feedback/pending
 * @access  Private (teacher)
 */
export const getPendingEssays = asyncHandler(async (req, res) => {
  const classes = await Class.find({
    teacher: req.user._id,
    status: { $in: ['active', 'archived'] },
  })
    .select('_id students')
    .lean()
  const classIds = classes.map(cls => cls._id)
  const studentIds = [...new Set(classes.flatMap(c => (c.students || []).map(s => s.toString())))]

  if (classIds.length === 0 || studentIds.length === 0) {
    return res.status(200).json({ success: true, count: 0, data: [] })
  }

  // Only feedback the teacher has actually submitted removes an essay from
  // the pending queue. A saved draft must keep the essay in the list.
  const submittedFeedbackEssayIds = await ManualFeedback.find({
    teacher: req.user._id,
    status: 'submitted',
  }).distinct('essay')

  const scopedFilter = await buildTeacherEssayScopeFromClassIds(
    { $in: studentIds },
    classIds,
  )
  const pendingEssays = await Essay.find({
    ...scopedFilter,
    status: { $in: ['submitted', 'reviewed'] },
    _id: { $nin: submittedFeedbackEssayIds },
  })
    .populate('student', 'name email englishLevel')
    .sort({ submittedAt: -1 })

  res.status(200).json({ success: true, count: pendingEssays.length, data: pendingEssays })
})

/**
 * @desc    Create feedback for an essay
 * @route   POST /api/feedback/:essayId
 * @access  Private (teacher)
 */
export const createFeedback = asyncHandler(async (req, res) => {
  const essay = await Essay.findById(req.params.essayId)
  if (!essay) throw new ErrorResponse('Essay not found', 404)

  await assertCanGradeEssay(req.user, essay)

  const existing = await ManualFeedback.findOne({ essay: essay._id, teacher: req.user._id })
  if (existing) throw new ErrorResponse('Feedback already exists for this essay. Use PUT to update.', 400)

  const { scores, feedbackText } = req.body

  const feedback = await ManualFeedback.create({
    essay: essay._id,
    teacher: req.user._id,
    scores: mergeTeacherScores({}, scores),
    feedbackText: feedbackText || '',
    status: 'draft',
  })

  // Draft scores stay in ManualFeedback until the teacher submits.

  res.status(201).json({ success: true, data: feedback })
})

/**
 * @desc    Update feedback (save draft)
 * @route   PUT /api/feedback/:id
 * @access  Private (teacher)
 */
export const updateFeedback = asyncHandler(async (req, res) => {
  const feedback = await ManualFeedback.findOne({ _id: req.params.id, teacher: req.user._id })
  if (!feedback) throw new ErrorResponse('Feedback not found', 404)

  const essay = await Essay.findById(feedback.essay)
  if (!essay) throw new ErrorResponse('Essay not found', 404)

  await assertCanGradeEssay(req.user, essay)

  const { scores, feedbackText } = req.body
  if (scores) feedback.scores = mergeTeacherScores(feedback.scores, scores)
  if (feedbackText !== undefined) feedback.feedbackText = feedbackText

  await feedback.save()

  // Saving a draft must not change the published analysis scores.

  res.status(200).json({ success: true, data: feedback })
})

/**
 * @desc    Submit feedback (finalize)
 * @route   PATCH /api/feedback/:id/submit
 * @access  Private (teacher)
 */
export const submitFeedback = asyncHandler(async (req, res) => {
  const feedback = await ManualFeedback.findOne({ _id: req.params.id, teacher: req.user._id })
  if (!feedback) throw new ErrorResponse('Feedback not found', 404)

  const essay = await Essay.findById(feedback.essay)
  if (!essay) throw new ErrorResponse('Essay not found', 404)

  await assertCanGradeEssay(req.user, essay)

  feedback.status = 'submitted'
  feedback.submittedAt = new Date()
  await feedback.save()

  // Sync teacher scores to AIAnalysis
  if (feedback.scores) {
    await syncTeacherScoresToAnalysis(feedback.essay, feedback.scores)
  }

  // Mark essay as reviewed
  const reviewedEssay = await Essay.findByIdAndUpdate(feedback.essay, { status: 'reviewed' }, { new: true })

  // Send real-time notification to student
  if (reviewedEssay) {
    const { createNotification } = await import('../services/notification.service.js')
    createNotification({
      recipient: reviewedEssay.student,
      sender: req.user._id,
      title: 'Nhận xét mới từ giáo viên',
      message: `Giáo viên ${req.user.name} đã nhận xét bài "${reviewedEssay.title}" của bạn.`,
      type: 'feedback',
      link: `/student/feedback?id=${reviewedEssay._id}`,
    }).catch(err => {
      console.error('Failed to send feedback notification:', err.message)
    })
  }

  res.status(200).json({ success: true, data: feedback, message: 'Feedback submitted' })
})

/**
 * @desc    Get feedback for a specific essay
 * @route   GET /api/feedback/essay/:essayId
 * @access  Private
 */
export const getFeedbackByEssay = asyncHandler(async (req, res) => {
  const essay = await Essay.findById(req.params.essayId).select('student status class assignment')
  if (!essay || !(await canAccessEssay(req.user, essay))) {
    // Do not reveal whether an inaccessible essay or its feedback exists.
    throw new ErrorResponse('Essay not found', 404)
  }

  // Teachers see their own draft while grading. Students, parents and any
  // other reader must only see feedback the teacher has explicitly submitted,
  // otherwise draft scores/notes leak before they are final.
  const filter = { essay: essay._id }
  if (req.user.role === 'teacher') {
    filter.teacher = req.user._id
  } else if (req.user.role !== 'admin') {
    filter.status = 'submitted'
  }

  const feedback = await ManualFeedback.findOne(filter)
    .populate('teacher', 'name')

  if (!feedback) {
    return res.status(200).json({ success: true, data: null })
  }

  res.status(200).json({ success: true, data: feedback })
})

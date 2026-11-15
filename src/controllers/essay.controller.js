import Essay from '../models/Essay.js'
import Config from '../models/Config.js'
import SystemPrompt from '../models/SystemPrompt.js'
import Class from '../models/Class.js'
import { processEssayAnalysis, generateTopicsByTheme, runAIHelperService } from '../services/ai.service.js'
import { awardEssayXp } from '../services/learningXp.service.js'
import { getIO } from '../services/socket.service.js'
import ErrorResponse from '../utils/ErrorResponse.js'
import asyncHandler from '../utils/asyncHandler.js'
import { canAccessEssay, essayVisibilityFilter, buildTeacherEssayScope } from '../utils/essayAccess.js'
import { reserveDailyEssayQuota, settleDailyEssayQuota } from '../services/aiQuota.js'

export function stripHtmlToPlainText(content) {
  if (typeof content !== 'string') return ''
  return content
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim()
}

/**
 * Helper to validate assignment existence, deadline, and student enrollment in an active class.
 * Ensures the student belongs to Class.students of the assignment's class, and the class is active.
 * Throws 404 if assignment not found.
 * Throws 400 if assignment is closed or past due.
 * Throws 403 if student is not enrolled or class is not active.
 * Returns the assignment object.
 */
async function validateAssignmentForStudent(
  assignmentId,
  userId,
  closedMessage = 'This assignment is closed and no longer accepting submissions.'
) {
  const Assignment = (await import('../models/Assignment.js')).default
  const assign = await Assignment.findById(assignmentId)
  if (!assign) {
    throw new ErrorResponse('Assignment not found', 404)
  }

  if (assign.status === 'closed' || (assign.dueDate && new Date(assign.dueDate) < new Date())) {
    throw new ErrorResponse(closedMessage, 400)
  }

  const classRef = assign.classId?._id || assign.classId
  let cls = assign.classId && assign.classId.students ? assign.classId : null
  if (!cls) {
    cls = await Class.findById(classRef)
  }

  const isEnrolled =
    cls &&
    cls.status === 'active' &&
    cls.students?.some((s) => (s?._id || s).toString() === userId.toString())

  if (!isEnrolled) {
    throw new ErrorResponse('Not authorized: You are not enrolled in the active class for this assignment', 403)
  }

  return assign
}

/**
 * @desc    Create a new essay (draft)
 * @route   POST /api/essays
 * @access  Private (student)
 */
export const createEssay = asyncHandler(async (req, res) => {
  const { title, content, theme } = req.body
  const assignmentId = req.body.assignmentId || req.body.assignment
  let classId = req.body.classId || req.body.class

  let finalAssignmentId = null
  if (assignmentId) {
    const assign = await validateAssignmentForStudent(
      assignmentId,
      req.user._id,
      'This assignment is closed and no longer accepting submissions.'
    )
    finalAssignmentId = assign._id
    classId = assign.classId?._id || assign.classId
  }

  const cleanContent = stripHtmlToPlainText(content || '')
  const essay = await Essay.create({
    title,
    content: cleanContent,
    student: req.user._id,
    class: classId || undefined,
    theme: theme || 'General',
    assignment: finalAssignmentId,
    status: 'draft',
  })

  res.status(201).json({ success: true, data: essay })
})

/**
 * @desc    Get all essays for current student
 * @route   GET /api/essays
 * @access  Private (student)
 */
export const getEssays = asyncHandler(async (req, res) => {
  const { status, page = 1, limit = 20 } = req.query

  // LG-15: never return the whole collection — scope the query to the
  // caller's role (admin: all, student: own, teacher: own classes, parent: children).
  const visibility = await essayVisibilityFilter(req.user)
  if (!visibility) {
    throw new ErrorResponse('Not authorized to view essays', 403)
  }

  const query = { ...visibility }
  if (status) query.status = status

  const essays = await Essay.find(query)
    .sort({ createdAt: -1 })
    .skip((page - 1) * limit)
    .limit(Number(limit))

  const total = await Essay.countDocuments(query)

  res.status(200).json({
    success: true,
    count: essays.length,
    total,
    page: Number(page),
    pages: Math.ceil(total / limit),
    data: essays,
  })
})

/**
 * @desc    Get single essay
 * @route   GET /api/essays/:id
 * @access  Private
 */
export const getEssay = asyncHandler(async (req, res) => {
  const essay = await Essay.findById(req.params.id).populate('student', 'name email')

  if (!essay) {
    throw new ErrorResponse('Essay not found', 404)
  }

  // Students can only view their own essays
  // Object-level authorization (BOLA/IDOR): admin, owning student, the
  // student's active teacher, or the student's parent may read.
  if (!(await canAccessEssay(req.user, essay))) {
    throw new ErrorResponse('Not authorized to access this essay', 403)
  }

  res.status(200).json({ success: true, data: essay })
})

/**
 * @desc    Update essay (save draft)
 * @route   PUT /api/essays/:id
 * @access  Private (student, owner only)
 */
export const updateEssay = asyncHandler(async (req, res) => {
  let essay = await Essay.findById(req.params.id)

  if (!essay) {
    throw new ErrorResponse('Essay not found', 404)
  }

  if (essay.student.toString() !== req.user._id.toString()) {
    throw new ErrorResponse('Not authorized to update this essay', 403)
  }

  if (essay.status === 'submitted' || essay.status === 'reviewed') {
    throw new ErrorResponse('Cannot edit a submitted or reviewed essay. Use revisions to make corrections.', 400)
  }

  const assignmentId = req.body.assignmentId || req.body.assignment || essay.assignment
  if (assignmentId) {
    const assign = await validateAssignmentForStudent(
      assignmentId,
      req.user._id,
      'This assignment is closed and no longer accepting edits.'
    )
    essay.assignment = assign._id
    essay.class = assign.classId?._id || assign.classId
  }

  const { title, content, theme } = req.body
  if (title !== undefined) essay.title = title
  if (content !== undefined) {
    const cleanContent = stripHtmlToPlainText(content)
    if (cleanContent !== essay.content) {
      essay.content = cleanContent
      essay.revisionCounter = (essay.revisionCounter || 0) + 1
    }
  }
  if (theme !== undefined) essay.theme = theme

  await essay.save()

  res.status(200).json({ success: true, data: essay })
})

/**
 * @desc    Submit essay for AI analysis
 * @route   PATCH /api/essays/:id/submit
 * @access  Private (student, owner only)
 */
export const submitEssay = asyncHandler(async (req, res) => {
  const essay = await Essay.findById(req.params.id)

  if (!essay) {
    throw new ErrorResponse('Essay not found', 404)
  }

  if (essay.student.toString() !== req.user._id.toString()) {
    throw new ErrorResponse('Not authorized', 403)
  }

  let assignment = null
  const assignmentId = essay.assignment || req.body?.assignmentId || req.body?.assignment
  if (assignmentId) {
    const assign = await validateAssignmentForStudent(
      assignmentId,
      req.user._id,
      'This assignment is closed and no longer accepting submissions.'
    )
    essay.assignment = assign._id
    essay.class = assign.classId?._id || assign.classId
    assignment = assign
  }

  // Archived classes are read-only: existing work stays visible to teachers,
  // but no new submission may be created for them.
  const classId = essay.class || assignment?.classId
  if (classId) {
    const cls = await Class.findById(classId).select('status')
    if (cls?.status === 'archived') {
      throw new ErrorResponse('This class is archived and no longer accepting submissions.', 400)
    }
  }

  if (essay.status !== 'draft' && essay.status !== 'needs_revision') {
    throw new ErrorResponse('Essay already submitted', 400)
  }

  if (!essay.content || essay.wordCount < 50) {
    throw new ErrorResponse('Essay must have at least 50 words to submit', 400)
  }

  const requestId = `essay-submit:${essay._id}:${essay.revisionCounter ?? 0}`
  let quotaReservation
  quotaReservation = await reserveDailyEssayQuota({
    student: req.user._id,
    requestId,
    kind: essay.revisionCounter > 0 ? 'revision' : 'submission',
  })
  if (!quotaReservation.reserved) {
    const limit = quotaReservation.tierInfo?.dailyAiEssayLimit || 3
    const tier = quotaReservation.tierInfo?.tier || 'free'
    const err = new ErrorResponse(`Daily AI essay limit reached (${limit}).`, 429, 'DAILY_ESSAY_LIMIT_REACHED')
    err.limit = limit
    err.tier = tier
    throw err
  }
  quotaReservation.requestId ??= requestId
  quotaReservation.day ??= null
  quotaReservation.tierInfo ??= { dailyAiEssayLimit: 9999 }
  essay.status = 'submitted'
  essay.submittedAt = new Date()
  try {
    await essay.save()
  } catch (error) {
    if (!quotaReservation.unmetered) {
      await settleDailyEssayQuota({ student: req.user._id, requestId, day: quotaReservation.day, outcome: 'release' })
    }
    throw error
  }

  // ── Load teacher's active system prompt (if any) ──
  let customPrompt = null
  let promptMeta = null
  try {
    let teacherId = null

    // Try to get teacher from the essay's class
    if (essay.class) {
      const cls = await Class.findById(essay.class).select('teacher')
      if (cls) teacherId = cls.teacher
    }

    // Fallback: find any class the student belongs to (take first active one)
    if (!teacherId) {
      const cls = await Class.findOne({ students: req.user._id, status: 'active' }).select('teacher').sort({ updatedAt: -1 })
      if (cls) teacherId = cls.teacher
    }

    if (teacherId) {
      const activePrompt = await SystemPrompt.findOne({ teacher: teacherId, status: 'active' })
        .sort({ updatedAt: -1 })
      if (activePrompt) {
        customPrompt = activePrompt.template
        promptMeta = { name: activePrompt.name, promptId: activePrompt._id }
        console.log(`[Essay Submit] Using custom prompt: "${activePrompt.name}" (teacher: ${teacherId})`)
      } else {
        console.log(`[Essay Submit] No active custom prompt for teacher ${teacherId}. Using default.`)
      }
    }
  } catch (promptErr) {
    console.error('[Essay Submit] Error loading custom prompt (falling back to default):', promptErr.message)
  }

  // Trigger AI analysis asynchronously (non-blocking)
  processEssayAnalysis(
    essay._id,
    req.user._id,
    essay.content,
    customPrompt,
    promptMeta,
    requestId,
    req.body?.language,
    {
      student: req.user._id,
      requestId: quotaReservation.requestId,
      day: quotaReservation.day,
    },
  ).then(async (analysis) => {
    if (!analysis) {
      if (!quotaReservation.unmetered) {
        await settleDailyEssayQuota({ student: req.user._id, requestId, day: quotaReservation.day, outcome: 'release' })
      }
      return
    }
    try {
      await awardEssayXp({
        studentId: req.user._id,
        essayId: essay._id,
        analysis,
      })
    } catch (xpErr) {
      console.error('Essay XP award failed:', xpErr.message)
    }
  }).catch(err => {
    Essay.updateOne(
      { _id: essay._id, revisionCounter: essay.revisionCounter ?? 0 },
      { $set: { aiAnalysisStatus: 'failed', aiAnalysisRevision: essay.revisionCounter ?? 0 } },
    ).catch(statusErr => {
      console.error('Failed to persist essay grading failure state:', statusErr.message)
    })
    settleDailyEssayQuota({ student: req.user._id, requestId, day: quotaReservation.day, outcome: 'release' })
      .catch((quotaErr) => console.error('Failed to release essay AI quota reservation:', quotaErr.message))
    console.error('Background AI analysis failed:', err.message)
  })

  res.status(200).json({ success: true, data: essay, message: 'Essay submitted successfully' })
})

/**
 * @desc    Delete essay (draft only)
 * @route   DELETE /api/essays/:id
 * @access  Private (student, owner only)
 */
export const deleteEssay = asyncHandler(async (req, res) => {
  const essay = await Essay.findById(req.params.id)

  if (!essay) {
    throw new ErrorResponse('Essay not found', 404)
  }

  if (essay.student.toString() !== req.user._id.toString()) {
    throw new ErrorResponse('Not authorized', 403)
  }

  if (essay.status !== 'draft') {
    throw new ErrorResponse('Cannot delete a submitted or reviewed essay', 400)
  }

  await essay.deleteOne()

  res.status(200).json({ success: true, message: 'Essay deleted' })
})

/**
 * @desc    Get essays by student ID (for teachers)
 * @route   GET /api/essays/student/:studentId
 * @access  Private (teacher)
 */
export const getEssaysByStudent = asyncHandler(async (req, res) => {
  const targetStudentId = req.params.studentId

  // Teachers may only list essays that belong to their own classes. An
  // archived class keeps its history, but never exposes the student's work in
  // a different teacher's class.
  const essayScope = await buildTeacherEssayScope(req.user._id, targetStudentId)
  if (!essayScope) {
    throw new ErrorResponse("Not authorized to view this student's essays", 403)
  }

  const essays = await Essay.find(essayScope)
    .sort({ createdAt: -1 })

  res.status(200).json({ success: true, count: essays.length, data: essays })
})

/**
 * @desc    Get AI suggested topics based on a theme
 * @route   GET /api/essays/suggest-topics
 * @access  Private (student)
 */
export const getSuggestedTopics = asyncHandler(async (req, res) => {
  const { theme } = req.query

  if (!theme) {
    throw new ErrorResponse('Please provide a theme in the query parameters', 400)
  }

  // Find all existing essay titles of this student to exclude them from AI suggestion
  const existingEssays = await Essay.find({ student: req.user._id })
    .select('title')
    .sort({ createdAt: -1 })
    .limit(50) // limit to avoid prompt context bloat
  const existingTitles = existingEssays.map(e => e.title).filter(Boolean)

  const topics = await generateTopicsByTheme(theme, existingTitles)
  res.status(200).json({ success: true, data: topics })
})

/**
 * @desc    Request a student to revise their essay
 * @route   PATCH /api/essays/:id/request-revision
 * @access  Private (teacher only)
 */
export const requestRevision = asyncHandler(async (req, res) => {
  if (req.user.role !== 'teacher') {
    throw new ErrorResponse('Not authorized: teachers only', 403)
  }

  const essay = await Essay.findById(req.params.id)
  if (!essay) {
    throw new ErrorResponse('Essay not found', 404)
  }
  if (!(await canAccessEssay(req.user, essay))) {
    throw new ErrorResponse('Not authorized to request revision for this essay', 403)
  }

  essay.status = 'needs_revision'
  await essay.save()

  // Create early warning or standard database notification for the student
  try {
    const Notification = (await import('../models/Notification.js')).default
    if (Notification) {
      await Notification.create({
        recipient: essay.student,
        sender: req.user._id,
        type: 'early_warning',
        title: 'Revision Requested',
        message: `Your teacher requested a revision for essay: "${essay.title}"`,
        relatedItem: essay._id,
        onModel: 'Essay'
      })
    }
  } catch (notiErr) {
    console.error('Could not create revision notification in database:', notiErr.message)
  }

  // Emit Socket event to student
  const io = getIO()
  if (io) {
    io.to(`user:${essay.student}`).emit('notification', {
      type: 'revision_requested',
      essayId: essay._id,
      title: essay.title,
      message: 'Your teacher has requested a revision on your essay.'
    })
  }

  res.status(200).json({ success: true, data: essay, message: 'Revision requested successfully' })
})

/**
 * @desc    Get whether student is allowed to paste essay
 * @route   GET /api/essays/paste-config
 * @access  Private (student)
 */
export const getPasteConfig = asyncHandler(async (req, res) => {
  const config = await Config.findOne({ key: 'ALLOW_PASTE_ESSAY' })
  res.status(200).json({
    success: true,
    allowPaste: config ? config.value === 'true' || config.value === true : true
  })
})

/**
 * @desc    Run AI Helper (Spellcheck / Improve) on text
 * @route   POST /api/essays/ai-helper
 * @access  Private (student)
 */
export const runAIHelper = asyncHandler(async (req, res) => {
  const { text, action } = req.body

  if (!text) {
    throw new ErrorResponse('Please provide text to process', 400)
  }

  if (!action || !['spellcheck', 'improve'].includes(action)) {
    throw new ErrorResponse('Please provide a valid action (spellcheck or improve)', 400)
  }

  const result = await runAIHelperService(text, action)
  res.status(200).json({ success: true, data: result })
})

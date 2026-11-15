import AIAnalysis from '../models/AIAnalysis.js'
import { createHash } from 'node:crypto'
import Essay from '../models/Essay.js'
import Class from '../models/Class.js'
import SystemPrompt from '../models/SystemPrompt.js'
import {
  getEssayContentHash,
  processEssayAnalysis,
  translateTextToVietnamese,
} from '../services/ai.service.js'
import { awardEssayXp } from '../services/learningXp.service.js'
import { reserveDailyEssayQuota, settleDailyEssayQuota } from '../services/aiQuota.js'
import ErrorResponse from '../utils/ErrorResponse.js'
import asyncHandler from '../utils/asyncHandler.js'
import ParentStudentLink from '../models/ParentStudentLink.js'
import { resolveEssayClassId } from '../utils/essayAccess.js'
import { dayKey, resolveAnalysisLanguage } from '../utils/learning.js'

async function authorizedEssay(req, writing = false) {
  let essay = null
  try {
    essay = await Essay.findById(req.params.essayId)
  } catch (err) {
    if (err.statusCode) throw err
  }
  if (!essay) return null
  let allowed = !req.user || req.user.role === 'admin'
  if (req.user?.role === 'student') {
    allowed = !essay.student || String(essay.student) === String(req.user._id)
  }
  if (req.user?.role === 'teacher') {
    const classId = await resolveEssayClassId(essay)
    if (!classId) {
      allowed = false
    } else {
      const cls = await Class.findOne({
        _id: classId,
        teacher: req.user._id,
        students: essay.student,
        // Archived classes are read-only history: teachers may read the saved
        // analysis, but starting a new analysis (writing=true) is still blocked.
        status: writing ? 'active' : { $in: ['active', 'archived'] },
      })
      allowed = Boolean(cls)
    }
  }
  if (req.user?.role === 'parent' && !writing) {
    allowed = essay.status !== 'draft'
      && Boolean(await ParentStudentLink.findOne({ parent: req.user._id, student: essay.student, status: 'active' }))
  }
  if (!allowed) throw new ErrorResponse('Essay not found', 404)
  return essay
}

/**
 * @desc    Get AI analysis for an essay
 * @route   GET /api/essays/:essayId/analysis
 * @access  Private
 */
export const getAnalysis = asyncHandler(async (req, res) => {
  const essay = await authorizedEssay(req)
  if (!essay) throw new ErrorResponse('Essay not found', 404)
  const analysis = await AIAnalysis.findOne({ essay: req.params.essayId })
    .populate('essay', 'title content wordCount')

  const currentRevision = essay.revisionCounter ?? 0
  const analysisRevision = analysis?.contentRevision ?? -1
  const currentContentHash = getEssayContentHash(essay.content)
  const isLegacyAnalysis = currentRevision === 0
    && analysisRevision < 0
    && !analysis?.contentHash
  const analysisMatchesCurrentEssay = analysisRevision === currentRevision
    && analysis?.contentHash === currentContentHash
  const statusMatchesCurrentRevision = essay.aiAnalysisRevision === currentRevision

  if (statusMatchesCurrentRevision && essay.aiAnalysisStatus === 'failed') {
    return res.status(200).json({ success: true, data: null, gradingStatus: 'failed' })
  }

  if (statusMatchesCurrentRevision && essay.aiAnalysisStatus === 'processing') {
    return res.status(200).json({ success: true, data: null, gradingStatus: 'processing' })
  }

  const hasCompletedAnalysis = analysis && (isLegacyAnalysis || analysisMatchesCurrentEssay)
  if (hasCompletedAnalysis && (!statusMatchesCurrentRevision || essay.aiAnalysisStatus === 'completed' || essay.aiAnalysisStatus === 'idle')) {
    console.info('[AI Feedback] Serving current essay analysis', {
      essayId: String(essay._id),
      essayRevision: currentRevision,
      analysisRevision,
      contentHashMatches: analysis.contentHash === currentContentHash,
      isFallback: Boolean(analysis.isFallback),
    })

    return res.status(200).json({ success: true, data: analysis, gradingStatus: 'completed' })
  }

  res.status(200).json({ success: true, data: null, gradingStatus: 'processing' })
})

/**
 * @desc    Trigger re-analysis of an essay
 * @route   POST /api/essays/:essayId/reanalyze
 * @access  Private
 */
export const reanalyze = asyncHandler(async (req, res) => {
  const essay = await authorizedEssay(req, true)

  if (!essay) {
    throw new ErrorResponse('Essay not found', 404)
  }

  if (essay.status === 'draft') {
    throw new ErrorResponse('Cannot analyze a draft essay', 400)
  }

  const currentRevision = essay.revisionCounter ?? 0
  if (essay.aiAnalysisStatus === 'processing' && (essay.aiAnalysisRevision ?? -1) === currentRevision) {
    throw new ErrorResponse('An AI analysis is already running for this essay revision', 409, 'AI_ANALYSIS_IN_PROGRESS')
  }

  // Load teacher's active system prompt before building aiRequestId so prompt
  // or language changes get their own provider idempotency key (AI-12).
  let customPrompt = null
  let promptMeta = null
  try {
    let teacherId = null
    if (essay.class) {
      const cls = await Class.findById(essay.class).select('teacher')
      if (cls) teacherId = cls.teacher
    }
    if (!teacherId) {
      const cls = await Class.findOne({ students: essay.student, status: 'active' }).select('teacher').sort({ updatedAt: -1 })
      if (cls) teacherId = cls.teacher
    }
    if (teacherId) {
      const activePrompt = await SystemPrompt.findOne({ teacher: teacherId, status: 'active' }).sort({ updatedAt: -1 })
      if (activePrompt) {
        customPrompt = activePrompt.template
        promptMeta = { name: activePrompt.name, promptId: activePrompt._id }
      }
    }
  } catch (promptErr) {
    console.error('[Reanalyze] Error loading custom prompt (falling back to default):', promptErr.message)
  }

  const outputLanguage = resolveAnalysisLanguage(req.body?.language)
  const promptFingerprint = customPrompt
    ? createHash('sha256').update(`${promptMeta?.promptId || ''}:${customPrompt}`).digest('hex').slice(0, 8)
    : ''
  const requestVariants = [outputLanguage !== 'en' ? outputLanguage : '', promptFingerprint].filter(Boolean)

  // AI-12: the provider idempotency key is deterministic per essay revision +
  // language + prompt variant, so retries reuse stored grading without 409 collisions.
  const aiRequestId = `essay-reanalyze:${essay._id}:${currentRevision}${requestVariants.length ? `:${requestVariants.join(':')}` : ''}`
  const requestId = `${aiRequestId}:${dayKey(new Date(), 'Asia/Ho_Chi_Minh')}`
  const quotaReservation = await reserveDailyEssayQuota({
    student: essay.student,
    requestId,
    kind: currentRevision > 0 ? 'revision' : 'submission',
  })
  if (!quotaReservation.reserved) {
    const limit = quotaReservation.tierInfo?.dailyAiEssayLimit || 3
    const tier = quotaReservation.tierInfo?.tier || 'free'
    const err = new ErrorResponse(
      `Daily AI essay limit reached (${limit}).`,
      429,
      'DAILY_ESSAY_LIMIT_REACHED',
    )
    err.limit = limit
    err.tier = tier
    throw err
  }

  let analysis = null
  try {
    analysis = await processEssayAnalysis(
      essay._id,
      essay.student,
      essay.content,
      customPrompt,
      promptMeta,
      aiRequestId,
      req.body?.language,
      { student: essay.student, requestId, day: quotaReservation.day },
    )
  } catch (err) {
    await settleDailyEssayQuota({ student: essay.student, requestId, day: quotaReservation.day, outcome: 'release' })
      .catch((quotaErr) => console.error('[Reanalyze] Quota release failed:', quotaErr.message))
    throw err
  }

  if (!analysis) {
    await settleDailyEssayQuota({ student: essay.student, requestId, day: quotaReservation.day, outcome: 'release' })
      .catch((quotaErr) => console.error('[Reanalyze] Quota release failed:', quotaErr.message))
    throw new ErrorResponse('The essay changed while it was being analyzed; retry', 409, 'AI_ANALYSIS_SUPERSEDED')
  }

  // Mark essay as reviewed
  essay.status = 'reviewed'
  await essay.save()

  await settleDailyEssayQuota({ student: essay.student, requestId, day: quotaReservation.day, outcome: 'consume' })
    .catch((quotaErr) => console.error('[Reanalyze] Quota consume failed:', quotaErr.message))

  try {
    await awardEssayXp({
      studentId: essay.student,
      essayId: essay._id,
      analysis,
    })
  } catch (xpErr) {
    console.error('Essay XP award failed:', xpErr.message)
  }

  res.status(200).json({ success: true, data: analysis })
})

/**
 * @desc    Translate selected text to Vietnamese
 * @route   POST /api/analysis/translate
 * @access  Private
 */
export const translateText = asyncHandler(async (req, res) => {
  const { text } = req.body

  if (!text) {
    throw new ErrorResponse('Please provide text to translate', 400)
  }

  const translation = await translateTextToVietnamese(text)
  res.status(200).json({ success: true, translation })
})

export const reanalyzeEssay = reanalyze


import { randomUUID } from 'node:crypto'
import Essay from '../models/Essay.js'
import EssayRevision from '../models/EssayRevision.js'
import LearningSession from '../models/LearningSession.js'
import Assignment from '../models/Assignment.js'
import Class from '../models/Class.js'
import asyncHandler from '../utils/asyncHandler.js'
import { fail, objectId, text, hash, requestKey } from '../utils/learning.js'
import { transactIntent, runLearningTransaction } from '../services/learningTransaction.service.js'
import {
  analyzeVocabulary,
  compareRevisions,
  validateAnalysis,
} from '../services/vocabularyAnalysis.service.js'
import { recordEvidence } from '../services/wordEvidence.service.js'
import { awardEssayXp } from '../services/learningXp.service.js'
import SystemPrompt from '../models/SystemPrompt.js'
import { processEssayAnalysis } from '../services/ai.service.js'
import { reserveDailyEssayQuota, settleDailyEssayQuota, ensureDailyEssayQuotaBucket } from '../services/aiQuota.js'
import ErrorResponse from '../utils/ErrorResponse.js'

const writingContent = (body) => {
  const content = text(body.content, 'content', 10000)
    .replace(/\r\n?/g, '\n')
    .normalize('NFC')
  if (/<[^>]*>/.test(content)) fail('Submit plain text, not HTML')
  const wordCount = content.split(/\s+/).length
  if (wordCount < 10) fail('Writing must contain at least 10 words')
  return { content, wordCount }
}

async function prepareRevision(req) {
  const { content, wordCount } = writingContent(req.body)
  const key = requestKey(req)
  const originalId = req.params.id ? objectId(req.params.id) : null
  if (originalId && !await Essay.findOne({ _id: originalId, student: req.user._id })) fail('Essay not found', 404)
  const sessionId = originalId ? null : objectId(req.body.sessionId, 'sessionId')
  const payload = {
    content,
    sessionId: sessionId ? String(sessionId) : null,
    essayId: originalId ? String(originalId) : null,
    targetWords: req.body.targetWords ?? null,
  }
  if (payload.targetWords !== null && (
    !Array.isArray(payload.targetWords) || payload.targetWords.length > 5 ||
    payload.targetWords.some((word) => typeof word !== 'string')
  )) fail('Invalid targetWords')

  let quotaReservation = null
  const intent = await transactIntent(req.user._id, 'revision', key, payload, async (tx) => {
    const session = await LearningSession.findOne(
      originalId
        ? { originalEssay: originalId, student: req.user._id }
        : { _id: sessionId, student: req.user._id },
    ).session(tx)
    if (!session) fail('Session not found', 404)
    if (session.status !== 'in_progress' || !['writing', 'feedback'].includes(session.currentStep)) fail('Session is not ready for writing', 409)
    const targets = session.targetWords.map((word) => word.word)
    if (payload.targetWords && (
      new Set(payload.targetWords).size !== targets.length ||
      payload.targetWords.some((word) => !targets.includes(word))
    )) fail('Target words must match the learning session')
    const pending = await EssayRevision.exists({ session: session._id, analysisStatus: { $in: ['pending', 'processing'] } }).session(tx)
    if (pending) fail('Finish analysis of the pending revision first', 409)

    let essay
    if (session.originalEssay) {
      essay = await Essay.findOne({ _id: session.originalEssay, student: req.user._id }).session(tx)
      if (!essay) fail('Essay not found', 404)
      if (!originalId) fail('Use the essay revisions endpoint for corrections', 409)
    } else {
      if (originalId) fail('Essay is not linked to a learning session', 409)
      let classId = null
      if (session.assignment) {
        const assignment = await Assignment.findOne({ _id: session.assignment, status: 'active' }).session(tx)
        if (!assignment || assignment.dueDate < new Date()) fail('Assignment unavailable', 409)
        const cls = await Class.findOne({ _id: assignment.classId, students: req.user._id, status: 'active' }).session(tx)
        if (!cls) fail('Assignment unavailable', 404)
        classId = cls._id
      }
      const [created] = await Essay.create([{
        student: req.user._id,
        title: session.learningSetSlug + ' practice',
        theme: session.theme,
        assignment: session.assignment,
        class: classId,
        content,
        status: 'submitted',
        submittedAt: new Date(),
      }], { session: tx })
      essay = created
      session.originalEssay = essay._id
    }

    const quotaRequestId = `essay-revision:${essay._id}:${(essay.revisionCounter || 0) + 1}`
    quotaReservation = await reserveDailyEssayQuota({
      student: req.user._id,
      requestId: quotaRequestId,
      kind: 'revision',
      session: tx,
    })
    if (!quotaReservation.reserved) {
      const limit = quotaReservation.tierInfo?.dailyAiEssayLimit || 3
      const tier = quotaReservation.tierInfo?.tier || 'free'
      const err = new ErrorResponse(`Daily AI essay limit reached (${limit}).`, 429, 'DAILY_ESSAY_LIMIT_REACHED')
      err.limit = limit
      err.tier = tier
      throw err
    }

    essay.revisionCounter = (essay.revisionCounter || 0) + 1
    essay.content = content
    essay.status = 'submitted'
    await essay.save({ session: tx })
    const [revision] = await EssayRevision.create([{
      student: req.user._id,
      originalEssay: essay._id,
      session: session._id,
      revisionNumber: essay.revisionCounter,
      content,
      wordCount,
      contentHash: hash(content),
      targetWords: targets,
      assisted: essay.revisionCounter > 1,
    }], { session: tx })
    await session.save({ session: tx })
    return { essayId: essay._id, revisionId: revision._id, revisionNumber: essay.revisionCounter, quotaRequestId }
  })

  if (intent.replayed && !quotaReservation) {
    quotaReservation = await reserveDailyEssayQuota({
      student: req.user._id,
      requestId: intent.result.quotaRequestId,
      kind: 'revision',
    })
  }
  if (!quotaReservation?.reserved) {
    throw new ErrorResponse('Could not reserve essay quota for this revision.', 503, 'ESSAY_QUOTA_RESERVATION_FAILED')
  }
  return { ...intent, quotaReservation, quotaRequestId: intent.result.quotaRequestId, requestId: key }
}

async function processRevision(id, user) {
  const claimToken = randomUUID()
  const now = new Date()
  let revision = await EssayRevision.findOneAndUpdate({
    _id: id,
    student: user._id,
    $or: [
      { analysisStatus: { $in: ['pending', 'failed'] } },
      { analysisStatus: 'processing', processingUntil: { $lt: now } },
    ],
  }, {
    $set: {
      analysisStatus: 'processing',
      processingToken: claimToken,
      processingUntil: new Date(Date.now() + 60000),
    },
  }, { returnDocument: 'after' })
  if (!revision) {
    revision = await EssayRevision.findOne({ _id: id, student: user._id })
    if (!revision) fail('Revision not found', 404)
    if (revision.analysisStatus === 'succeeded') return revision
    fail('Revision analysis is already running; retry shortly', 409)
  }
  try {
    const session = await LearningSession.findById(revision.session)
    const generated = await analyzeVocabulary(revision.content, revision.targetWords, {
      meanings: session.targetWords.map((word) => ({ word: word.word, meaning: word.definitionVi, partOfSpeech: word.partOfSpeech })),
    })
    const analysis = validateAnalysis(generated, revision.content, revision.targetWords)
    const previous = await EssayRevision.findOne({
      originalEssay: revision.originalEssay,
      revisionNumber: { $lt: revision.revisionNumber },
      analysisStatus: 'succeeded',
    }).sort({ revisionNumber: -1 })
    const comparison = compareRevisions(previous?.analysis, analysis)
    await runLearningTransaction(async (tx) => {
      const current = await EssayRevision.findOne({
        _id: id,
        processingToken: claimToken,
        analysisStatus: 'processing',
      }).session(tx)
      if (!current) fail('Analysis claim expired', 409)
      await recordEvidence(current, session, analysis, user.learningProfile?.timezone || 'Asia/Ho_Chi_Minh', tx)
      current.analysis = analysis
      current.targetWordResults = analysis.targetWordResults
      current.feedbackSummary = analysis.summary
      current.comparison = comparison
      current.analysisStatus = 'succeeded'
      current.errorCode = undefined
      await current.save({ session: tx })
      await LearningSession.updateOne({ _id: session._id, status: 'in_progress' }, { $set: { currentStep: 'feedback' } }, { session: tx })
      await Essay.updateOne({ _id: current.originalEssay }, { $set: { status: 'reviewed' } }, { session: tx })
    })
    return await EssayRevision.findById(id)
  } catch (err) {
    await EssayRevision.updateOne(
      { _id: id, processingToken: claimToken, analysisStatus: 'processing' },
      { $set: { analysisStatus: 'failed', errorCode: 'ANALYSIS_FAILED' } },
    )
    throw err
  }
}

async function startRevisionEssayAnalysis(revisionId, studentId, language, quotaMeta) {
  try {
    const revision = await EssayRevision.findById(revisionId)
    if (!revision) throw new Error('Saved essay revision was not found')
    let customPrompt = null
    let promptMeta = null
    let teacherId = null
    const essay = await Essay.findById(revision.originalEssay)
    if (!essay) throw new Error('Essay for the saved revision was not found')
    if (essay.class) {
      const cls = await Class.findById(essay.class).select('teacher')
      if (cls) teacherId = cls.teacher
    }
    if (!teacherId) {
      const cls = await Class.findOne({ students: studentId, status: 'active' }).select('teacher').sort({ updatedAt: -1 })
      if (cls) teacherId = cls.teacher
    }
    if (teacherId) {
      try {
        const activePrompt = await SystemPrompt.findOne({ teacher: teacherId, status: 'active' }).sort({ updatedAt: -1 })
        if (activePrompt) {
          customPrompt = activePrompt.template
          promptMeta = { name: activePrompt.name, promptId: activePrompt._id }
        }
      } catch (promptErr) {
        console.error('[Revision AI Analysis] Prompt lookup failed; using default prompt:', promptErr.message)
      }
    }
    processEssayAnalysis(
      essay._id,
      studentId,
      revision.content,
      customPrompt,
      promptMeta,
      quotaMeta.aiRequestId,
      language,
      quotaMeta,
    ).then(async (analysis) => {
      if (!analysis) {
        await settleDailyEssayQuota({ student: studentId, requestId: quotaMeta.requestId, day: quotaMeta.day, outcome: 'release' })
        return
      }
      try {
        await awardEssayXp({ studentId, essayId: essay._id, revisionId, analysis })
      } catch (xpErr) {
        console.error('[Revision AI Analysis] XP award failed:', xpErr.message)
      }
    }).catch(async (err) => {
      await Essay.updateOne(
        { _id: essay._id, revisionCounter: revision.revisionNumber },
        { $set: { aiAnalysisStatus: 'failed', aiAnalysisRevision: revision.revisionNumber } },
      ).catch((statusErr) => console.error('[Revision AI Analysis] Could not persist failed grading state:', statusErr.message))
      await settleDailyEssayQuota({ student: studentId, requestId: quotaMeta.requestId, day: quotaMeta.day, outcome: 'release' })
        .catch((quotaErr) => console.error('[Revision AI Analysis] Quota release failed:', quotaErr.message))
      console.error('[Revision AI Analysis] Background analysis error:', err.message)
    })
  } catch (err) {
    await settleDailyEssayQuota({ student: studentId, requestId: quotaMeta?.requestId, day: quotaMeta?.day, outcome: 'release' })
      .catch((quotaErr) => console.error('[Revision AI Analysis] Quota release failed:', quotaErr.message))
    console.error('[Revision AI Analysis] Could not start full essay analysis:', err.message)
  }
}

export const submitRevision = asyncHandler(async (req, res) => {
  const prepared = await prepareRevision(req)
  if (!prepared.replayed) {
    void startRevisionEssayAnalysis(prepared.result.revisionId, req.user._id, req.body?.language, {
      student: req.user._id,
      requestId: prepared.quotaRequestId,
      day: prepared.quotaReservation.day,
      aiRequestId: prepared.quotaRequestId,
    })
  }
  try {
    const revision = await processRevision(prepared.result.revisionId, req.user)
    res.status(prepared.replayed ? 200 : 201).json({ success: true, data: revision, essayId: revision.originalEssay, sessionId: revision.session })
  } catch (err) {
    if (err.statusCode === 502 || err.statusCode === 503) {
      return res.status(err.statusCode).json({
        success: false,
        error: err.message,
        revisionId: prepared.result.revisionId,
        retryUrl: '/api/essays/revisions/' + prepared.result.revisionId + '/analyze',
      })
    }
    throw err
  }
})
export const retryRevision = asyncHandler(async (req, res) => {
  const revision = await processRevision(objectId(req.params.revisionId), req.user)
  res.json({ success: true, data: revision })
})
export const getRevisions = asyncHandler(async (req, res) => {
  const essay = await Essay.findOne({ _id: objectId(req.params.id), student: req.user._id })
  if (!essay) fail('Essay not found', 404)
  const revisions = await EssayRevision.find({ originalEssay: essay._id, student: req.user._id }).sort({ revisionNumber: -1 }).limit(100)
  res.json({ success: true, data: revisions })
})

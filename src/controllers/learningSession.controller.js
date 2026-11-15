import mongoose from 'mongoose'
import LearningSession from '../models/LearningSession.js'
import LearningSet from '../models/LearningSet.js'
import PracticeAttempt from '../models/PracticeAttempt.js'
import EssayRevision from '../models/EssayRevision.js'
import Essay from '../models/Essay.js'
import Vocabulary from '../models/Vocabulary.js'
import Assignment from '../models/Assignment.js'
import Class from '../models/Class.js'
import asyncHandler from '../utils/asyncHandler.js'
import {
  fail,
  text,
  objectId,
  publicLearning,
  integer,
} from '../utils/learning.js'
import { buildAdaptiveSession } from '../services/adaptiveWordClassifier.service.js'
import { getTopicRoundSessions, selectTopicRound } from '../services/topicRound.service.js'
import { getUserEffectiveTier } from '../services/tier.service.js'
import ErrorResponse from '../utils/ErrorResponse.js'
import { learningSetLibraryFilter, isLearningSetVisible } from '../middleware/entitlement.middleware.js'

async function sessionSetIsAccessible(req, session) {
  // Assignment sessions are granted by class membership, not by tier.
  if (session.assignment) return true
  const set = await LearningSet.findOne({ _id: session.learningSet, status: 'published' }).lean()
  if (!set) return false
  return isLearningSetVisible(req, set)
}

export const startLearningSession = asyncHandler(async (req, res) => {
  const mode = req.body.mode === 'adaptive' ? 'adaptive' : 'static'
  const requestedSlug = req.body.learningSetSlug
  const requestedAssignmentId = req.body.assignmentId ? String(req.body.assignmentId) : null
  const active = await LearningSession.findOne({
    student: req.user._id,
    status: 'in_progress',
  })
  if (active) {
    const isSameSlug = !requestedSlug || active.learningSetSlug === requestedSlug
    const isSameMode = !req.body.mode || active.mode === mode
    const activeAssignmentId = active.assignment ? String(active.assignment) : null
    const isSameAssignment = activeAssignmentId === requestedAssignmentId
    if (isSameSlug && isSameMode && isSameAssignment) {
      // A session created before a tier change must not hand the words back to an
      // account that no longer has access to that set.
      if (active.learningSet && !(await sessionSetIsAccessible(req, active))) {
        fail('Learning set not found', 404)
      }
      return res.json({
        success: true,
        data: publicLearning(active),
        message: 'Continue your current learning session',
      })
    }
  }

  // Free trial quota check (học thử 3 lần trong 24h nếu chưa mua gói)
  const isAssignmentReq = Boolean(req.body.assignmentId)
  if (!isAssignmentReq) {
    const tierInfo = await getUserEffectiveTier(req.user)
    if (tierInfo.tier === 'free') {
      const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000)
      const usedIn24h = await LearningSession.countDocuments({
        student: req.user._id,
        createdAt: { $gte: since24h },
        assignment: null,
      })
      if (usedIn24h >= 3) {
        const err = new ErrorResponse(
          'Bạn đã sử dụng hết 3 lượt học thử miễn phí trong 24 giờ. Vui lòng nâng cấp gói để tiếp tục học không giới hạn.',
          403,
        )
        err.code = 'TRIAL_LIMIT_EXCEEDED'
        throw err
      }
    }
  }

  if (active) {
    // Dùng atomic updateMany để tránh VersionError (optimistic concurrency) khi có nhiều request đồng thời
    await LearningSession.updateMany(
      {
        student: req.user._id,
        status: 'in_progress',
      },
      { $set: { status: 'abandoned' } },
    )
  }
  let assignment = null
  if (req.body.assignmentId) {
    assignment = await Assignment.findById(
      objectId(req.body.assignmentId, 'assignmentId'),
    )
    if (
      !assignment ||
      assignment.status !== 'active' ||
      assignment.dueDate < new Date()
    )
      fail('Assignment unavailable', 404)
    const cls = await Class.findOne({
      _id: assignment.classId,
      students: req.user._id,
      status: 'active',
    })
    if (!cls) fail('Assignment unavailable', 404)
    // Assignment chỉ hỗ trợ static mode (lấy từ learningSet cố định)
    if (mode === 'adaptive') fail('Assignment not supported in adaptive mode', 400)
  }
  // ============ ADAPTIVE MODE ============
  if (mode === 'adaptive') {
    const adaptive = await buildAdaptiveSession(req.user._id, {
      sessionSize: 5,
      ratio: { due: 3, weak: 1, new: 1, lib: 0 },
    })

    // Nếu user hoàn toàn mới (chưa có vocabulary nào) → không tạo session,
    // để frontend có thể chuyển sang static mode hoặc onboarding.
    if (adaptive.targets.length === 0)
      fail(
        'No vocabulary history yet — complete a few lessons first, or switch to static mode',
        404,
      )

    const adaptiveTargets = adaptive.targets.map((t) => ({
      word: t.word,
      wordId: t.wordId,
      theme: t.theme || 'General',
      category: t.category,
      vocabularyId: t.vocabularyId || null,
      masteryLevel: t.masteryLevel || null,
      reason: t.reason,
    }))

    // Hỗ trợ cả replica set (production) và standalone MongoDB (dev/test).
    // Nếu transaction không khả dụng (standalone) → fallback create bình thường.
    const sessionData = {
      student: req.user._id,
      mode: 'adaptive',
      adaptiveReason: adaptive.reason,
      learningSet: null,
      learningSetSlug: null,
      theme: 'Adaptive',
      level: req.user.learningProfile?.targetLevel || 'B1',
      setVersion: new Date(),
      targetWords: adaptiveTargets,
      assignment: null,
    }
    let created
    let useTransaction = true
    try {
      // Thử transaction trước (replica set)
      created = await mongoose.connection.transaction(async (tx) => {
        const [s] = await LearningSession.create([sessionData], { session: tx })
        return s
      })
    } catch (txErr) {
      // Nếu transaction không khả dụng (standalone MongoDB) → fallback no-tx
      const isStandalone =
        txErr?.message?.includes('Transaction numbers') ||
        txErr?.message?.includes('replica set') ||
        txErr?.code === 20 ||
        txErr?.codeName === 'IllegalOperation'
      if (!isStandalone) throw txErr
      useTransaction = false
    }

    // Nếu transaction fail (standalone) → tạo trực tiếp
    if (!useTransaction || !created) {
      try {
        const [s] = await LearningSession.create([sessionData])
        created = s
      } catch (err) {
        // 11000 = duplicate (session in_progress đã tồn tại) hoặc VersionError do concurrent write
        if (err.code !== 11000 && err.name !== 'VersionError') throw err
        const existing = await LearningSession.findOne({
          student: req.user._id,
          status: 'in_progress',
        })
        if (!existing) throw err
        return res.json({
          success: true,
          data: publicLearning(existing),
          message: 'Continue your current learning session',
        })
      }
    }
    return res.status(201).json({ success: true, data: publicLearning(created) })
  }

  // ============ STATIC MODE (original) ============
  // Starting a session hands over the full set, so the library boundary from
  // PAY-02 must be applied here too; otherwise a locked set is still reachable
  // by posting its slug even though the read endpoints answer 404.
  let query = await learningSetLibraryFilter(req)
  if (assignment) {
    if (!assignment.learningSetId) fail('Assignment has no learning set')
    query._id = assignment.learningSetId
  } else if (req.body.learningSetSlug !== undefined)
    query.slug = text(req.body.learningSetSlug, 'learningSetSlug', 100)
  else {
    query.level = req.user.learningProfile?.targetLevel || 'B1'
    if (req.user.learningProfile?.interests?.length)
      query.category = { $in: req.user.learningProfile.interests }
  }
  let set = await LearningSet.findOne(query).sort({ slug: 1 }).lean()
  if (!set && !assignment && req.body.learningSetSlug === undefined)
    set = await LearningSet.findOne({ ...query, level: undefined })
      .sort({ slug: 1 })
      .lean()
  if (!set || set.items.length < 1)
    fail('No published learning set available', 404)
  if (!assignment && !(await isLearningSetVisible(req, set)))
    fail('Learning set not found', 404)
  const targets = assignment ? set.items
    .slice(0, 5)
    .map((w, i) => ({
      ...w,
      word: w.word.toLowerCase(),
      wordId: set._id + ':' + i,
    })) : selectTopicRound(set, await getTopicRoundSessions(req.user._id)).targetWords
  let created
  let useTransaction = true
  const sessionData = {
    student: req.user._id,
    mode: 'static',
    adaptiveReason: null,
    learningSet: set._id,
    learningSetSlug: set.slug,
    theme: set.title || set.category,
    level: set.level,
    setVersion: set.updatedAt,
    targetWords: targets,
    assignment: assignment?._id || null,
  }

  try {
    created = await mongoose.connection.transaction(async (tx) => {
      const [session] = await LearningSession.create([sessionData], { session: tx })
      for (const w of targets)
        await Vocabulary.updateOne(
          { student: req.user._id, word: w.word },
          {
            $setOnInsert: {
              student: req.user._id,
              word: w.word,
              theme: set.category,
              definition: w.definitionVi,
              partOfSpeech: w.partOfSpeech,
              ipa: w.phonetic,
              exampleSentence: w.exampleSentences?.[0] || '',
              masteryLevel: 'new',
              reviewCount: 0,
            },
          },
          { upsert: true, session: tx },
        )
      return session
    })
  } catch (txErr) {
    const isStandalone =
      txErr?.message?.includes('Transaction numbers') ||
      txErr?.message?.includes('replica set') ||
      txErr?.message?.includes('does not support retryable writes') ||
      txErr?.code === 20 ||
      txErr?.codeName === 'IllegalOperation'
    if (!isStandalone) {
      if (txErr.code === 11000 || txErr.name === 'VersionError') {
        const existing = await LearningSession.findOne({
          student: req.user._id,
          status: 'in_progress',
        })
        if (existing) {
          const existingAssign = existing.assignment ? String(existing.assignment) : null
          if (existingAssign === requestedAssignmentId) {
            return res.json({
              success: true,
              data: publicLearning(existing),
              message: 'Continue your current learning session',
            })
          }
        }
      }
      throw txErr
    }
    useTransaction = false
  }

  if (!useTransaction || !created) {
    try {
      const [session] = await LearningSession.create([sessionData])
      for (const w of targets)
        await Vocabulary.updateOne(
          { student: req.user._id, word: w.word },
          {
            $setOnInsert: {
              student: req.user._id,
              word: w.word,
              theme: set.category,
              definition: w.definitionVi,
              partOfSpeech: w.partOfSpeech,
              ipa: w.phonetic,
              exampleSentence: w.exampleSentences?.[0] || '',
              masteryLevel: 'new',
              reviewCount: 0,
            },
          },
          { upsert: true },
        )
      created = session
    } catch (err) {
      if (err.code !== 11000 && err.name !== 'VersionError') throw err
      const existing = await LearningSession.findOne({
        student: req.user._id,
        status: 'in_progress',
      })
      if (!existing) throw err
      const existingAssign = existing.assignment ? String(existing.assignment) : null
      if (existingAssign !== requestedAssignmentId) throw err
      return res.json({
        success: true,
        data: publicLearning(existing),
        message: 'Continue your current learning session',
      })
    }
  }
  res.status(201).json({ success: true, data: publicLearning(created) })
})
export const getCurrentSession = asyncHandler(async (req, res) => {
  const session = await LearningSession.findOne({
    student: req.user._id,
    status: 'in_progress',
  })
  if (session && !(await sessionSetIsAccessible(req, session))) {
    return res.json({ success: true, data: null })
  }
  res.json({ success: true, data: session ? publicLearning(session) : null })
})
export const getSessionForEssay = asyncHandler(async (req, res) => {
  const essayId = objectId(req.params.essayId, 'essayId')
  const essay = await Essay.findOne({ _id: essayId, student: req.user._id }).select('_id')
  if (!essay) fail('Essay not found', 404)

  const session = await LearningSession.findOne({
    student: req.user._id,
    originalEssay: essayId,
  })
  if (session && !(await sessionSetIsAccessible(req, session))) {
    fail('Learning set not found', 404)
  }
  res.json({ success: true, data: session ? publicLearning(session) : null })
})
export const reopenSessionForRevision = asyncHandler(async (req, res) => {
  const session = await LearningSession.findOne({
    _id: objectId(req.params.id),
    student: req.user._id,
  })
  if (!session) fail('Learning session not found', 404)
  if (!(await sessionSetIsAccessible(req, session))) fail('Learning set not found', 404)

  const essay = await Essay.findOne({
    _id: objectId(req.body.essayId, 'essayId'),
    student: req.user._id,
  })
  if (!essay) fail('Essay not found', 404)
  if (String(session.originalEssay) !== String(essay._id))
    fail('Essay is not linked to this learning session', 409)
  if (!['in_progress', 'completed'].includes(session.status))
    fail('Learning session can no longer be revised', 409)

  session.status = 'in_progress'
  session.currentStep = 'feedback'
  session.completedAt = null
  await session.save()
  res.json({ success: true, data: publicLearning(session) })
})
export const updateSessionStep = asyncHandler(async (req, res) => {
  const session = await LearningSession.findOne({
    _id: objectId(req.params.id),
    student: req.user._id,
  })
  if (!session) fail('Session not found', 404)
  if (!(await sessionSetIsAccessible(req, session))) fail('Learning set not found', 404)
  const steps = ['lesson', 'practice', 'writing', 'feedback', 'completed']
  const target = req.body.currentStep
  if (target !== undefined && !steps.includes(target))
    fail('Invalid currentStep')
  if (
    req.body.status !== undefined &&
    !['in_progress', 'completed', 'abandoned'].includes(req.body.status)
  )
    fail('Invalid status')
  if (req.body.status === 'abandoned') {
    if (session.status === 'completed') fail('Session already completed', 409)
    session.status = 'abandoned'
  } else {
    if (session.status !== 'in_progress') {
      if (session.status === 'completed' && target === 'completed')
        return res.json({ success: true, data: publicLearning(session) })
      fail('Session is no longer active', 409)
    }
    const next = target || session.currentStep,
      delta = steps.indexOf(next) - steps.indexOf(session.currentStep)
    const returningToStudy = ['practice', 'writing'].includes(session.currentStep)
      && ['lesson', 'practice'].includes(next) && delta < 0
    if ((!returningToStudy && delta < 0) || delta > 1) fail('Complete the current step first', 409)
    if (req.body.status === 'completed' && next !== 'completed')
      fail('Complete feedback first', 409)
    if (next === 'writing') {
      const practiced = await PracticeAttempt.distinct('wordId', {
        session: session._id,
        student: req.user._id,
      })
      if (session.targetWords.some((w) => !practiced.includes(w.wordId))) {
        fail('Practice every target word first', 409)
      }
    }
    if (['feedback', 'completed'].includes(next)) {
      const reviewed = await EssayRevision.findOne({
        session: session._id,
        student: req.user._id,
      }).sort({ revisionNumber: -1 })
      if (!reviewed || reviewed.analysisStatus !== 'succeeded')
        fail('Submit writing and wait for feedback first', 409)
    }
    session.currentStep = next
    if (next === 'completed') {
      session.status = 'completed'
      session.completedAt = new Date()
    }
  }
  if (req.body.activeTimeSeconds !== undefined) {
    const reported = integer(req.body.activeTimeSeconds, 0, 0, 86400)
    session.activeTimeSeconds = Math.min(
      Math.max(session.activeTimeSeconds, reported),
      Math.max(
        0,
        Math.floor((Date.now() - session.startedAt.getTime()) / 1000),
      ),
    )
  }
  // Optimistic concurrency prevents an old tab from undoing a completed session.
  await session.save()
  res.json({ success: true, data: publicLearning(session) })
})

export const getLearningPathRecommendation = asyncHandler(async (req, res) => {
  try {
    const { getPersonalizedLearningPath } = await import('../services/aiRecommendation.service.js')

    // GĐ6 — Đọc mode từ query (?mode=static|adaptive)
    // Adaptive → AI chọn 5 từ yếu nhất (masteryLevel: new/learning)
    // Static   → AI chọn 5 từ mới theo topic/interests
    const mode = (req.query.mode || 'static').toLowerCase()
    const effectiveMode = ['static', 'adaptive'].includes(mode) ? mode : 'static'

    // Get student's learning data
    const [recentWords, weakWords, completedSessions] = await Promise.all([
      Vocabulary.find({ student: req.user._id })
        .sort({ createdAt: -1 })
        .limit(20)
        .lean(),
      Vocabulary.find({ student: req.user._id, masteryLevel: { $in: ['new', 'learning'] } })
        .sort({ createdAt: -1 })
        .limit(10)
        .lean(),
      LearningSession.countDocuments({ student: req.user._id, status: 'completed' }),
    ])

    const recommendation = await getPersonalizedLearningPath(req.user, {
      recentWords,
      weakWords,
      completedSessions,
      dailyGoalMinutes: req.user.learningProfile?.dailyGoalMinutes || 10,
      pace: req.user.learningProfile?.pace || 'standard',
      mode: effectiveMode,
    })

    res.json({
      success: true,
      data: {
        ...recommendation,
        currentLevel: req.user.learningProfile?.targetLevel || 'B1',
        interests: req.user.learningProfile?.interests || [],
        dailyGoalMinutes: req.user.learningProfile?.dailyGoalMinutes || 10,
        pace: req.user.learningProfile?.pace || 'standard',
        completedSessions,
      },
    })
  } catch (error) {
    console.error('Learning path recommendation error:', error.message)
    // Fallback response — luôn trả suggestedWords mẫu để UI không bị rỗng
    const fallbackGoal = req.user.learningProfile?.dailyGoalMinutes || 10
    const fallbackPace = req.user.learningProfile?.pace || 'standard'
    const fallbackInterests = req.user.learningProfile?.interests || ['general']
    const fallbackLevel = req.user.learningProfile?.targetLevel || 'B1'
    const effectiveMode = ['static', 'adaptive'].includes(req.query.mode) ? req.query.mode : 'static'
    res.json({
      success: true,
      data: {
        recommendedLevel: fallbackLevel,
        focusAreas: ['vocabulary'],
        suggestedTopics: fallbackInterests,
        suggestedTopicSlugs: fallbackInterests.map(i => i.toLowerCase().replace(/\s+/g, '-')),
        // GĐ6 — Fallback 5 từ mẫu theo mode (vì AI lỗi)
        suggestedWords: effectiveMode === 'adaptive'
          ? ['review', 'practice', 'remember', 'repeat', 'master']
          : ['explore', 'discover', 'journey', 'experience', 'learn'],
        dailyGoalMinutes: fallbackGoal,
        pace: fallbackPace,
        nextMilestone: 'Continue your learning journey!',
        learningPlan: `Build vocabulary ${fallbackGoal} minutes a day at a ${fallbackPace} pace.`,
        currentLevel: fallbackLevel,
        interests: fallbackInterests,
        completedSessions: 0,
        _fallback: true,  // Flag để frontend biết đang dùng fallback
      },
    })
  }
})

/**
 * @desc    Get trial quota status for student (3 sessions in 24h for free tier)
 * @route   GET /api/sessions/trial-status
 * @access  Private (Student)
 */
export const getTrialStatus = asyncHandler(async (req, res) => {
  const tierInfo = await getUserEffectiveTier(req.user)
  const isPaid = tierInfo.tier !== 'free'

  if (isPaid) {
    return res.status(200).json({
      success: true,
      data: {
        isPaid: true,
        tier: tierInfo.tier,
        used: 0,
        limit: 3,
        remaining: 999,
        allowed: true,
      },
    })
  }

  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000)
  const used = await LearningSession.countDocuments({
    student: req.user._id,
    createdAt: { $gte: since24h },
    assignment: null,
  })

  const limit = 3
  const remaining = Math.max(0, limit - used)

  return res.status(200).json({
    success: true,
    data: {
      isPaid: false,
      tier: 'free',
      used,
      limit,
      remaining,
      allowed: remaining > 0,
    },
  })
})

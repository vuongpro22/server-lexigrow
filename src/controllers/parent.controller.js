import { createHash, randomInt } from 'crypto'
import User from '../models/User.js'
import Essay from '../models/Essay.js'
import AIAnalysis from '../models/AIAnalysis.js'
import Vocabulary from '../models/Vocabulary.js'
import Alert from '../models/Alert.js'
import Class from '../models/Class.js'
import WeeklyGoal from '../models/WeeklyGoal.js'
import ChildLinkCode from '../models/ChildLinkCode.js'
import ParentStudentLink from '../models/ParentStudentLink.js'
import { activateParentStudentLink } from '../services/parentLink.service.js'
import { syncParentLinkedRooms } from '../services/socket.service.js'
import asyncHandler from '../utils/asyncHandler.js'
import ErrorResponse from '../utils/ErrorResponse.js'
import { effectiveMastery, getMasteredWords, withEffectiveMastery } from '../services/masteryView.service.js'
import { countLearnedWords } from './goals.controller.js'

const LINK_CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'
const LINK_CODE_LENGTH = 8
const LINK_CODE_TTL_MS = 15 * 60 * 1000
// A used code with no active link is treated as "still processing" only for a
// short window. After that the same request is a plain expired/used code.
const LINK_REQUEST_GRACE_MS = 2 * 60 * 1000
const VALID_RELATIONSHIPS = ['father', 'mother', 'guardian', 'other']
// PARENT-05 / LG-10 / ST-07: parents only see work the student actually
// submitted; drafts stay private until the student submits them.
const PARENT_VISIBLE_ESSAY_STATUSES = ['submitted', 'reviewed', 'needs_revision']

function getParentAlertDetail(alert) {
  if (alert.metric === 'vocabulary_stagnation') {
    return 'No new vocabulary was added for four consecutive weeks.'
  }
  if (alert.metric === 'grammar_decline') {
    const scoreSequence = alert.detail?.match(/\(([^)]+)\)/)?.[1]
    return `Grammar accuracy declined across the latest three reviewed essays${scoreSequence ? ` (${scoreSequence})` : ''}.`
  }
  if (alert.metric === 'overall_score_decline') {
    return alert.detail || 'Overall writing score declined across the latest three reviewed essays.'
  }
  if (alert.metric === 'missed_assignment_deadline') {
    return alert.detail || 'An assignment deadline passed without a submission.'
  }
  return alert.detail
}

const hashLinkCode = code => createHash('sha256').update(code).digest('hex')

const maskEmail = email => {
  const [localPart, domain] = String(email || '').split('@')
  if (!localPart || !domain) return ''
  return `${localPart.slice(0, 3)}***@${domain}`
}

const generateLinkCode = () => Array.from(
  { length: LINK_CODE_LENGTH },
  () => LINK_CODE_ALPHABET[randomInt(LINK_CODE_ALPHABET.length)]
).join('')

/**
 * PARENT-01: ParentStudentLink is the source of truth. Never authorise a
 * parent from the denormalised User.children array, which can lag behind a
 * revocation.
 */
async function assertActiveChildLink(parentId, studentId, message) {
  const link = await ParentStudentLink.findOne({
    parent: parentId,
    student: studentId,
    status: 'active',
  })
  if (!link) {
    throw new ErrorResponse(message, 403)
  }
  return link
}

const buildLinkSuccess = (link, child) => ({
  success: true,
  message: `Successfully linked with student ${child.name}`,
  data: {
    linkId: link._id,
    student: {
      _id: child._id,
      name: child.name,
      avatar: child.avatar,
      englishLevel: child.englishLevel,
    },
    relationship: link.relationship,
  },
})

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

/**
 * A second device can submit the same code a few milliseconds before the
 * first request finishes creating the link. Wait briefly for the winner to
 * become visible so both devices can show the same success state instead of
 * a confusing "already used" error.
 */
async function waitForActiveLink(parentId, studentId, timeoutMs = 750) {
  const deadline = Date.now() + timeoutMs
  while (true) {
    const link = await ParentStudentLink.findOne({
      parent: parentId,
      student: studentId,
      status: 'active',
    })
    if (link) return link
    if (Date.now() >= deadline) return null
    await sleep(75)
  }
}

function getCurrentWeekBounds() {
  const now = new Date()
  const dayOfWeek = now.getDay()
  const diffToMonday = dayOfWeek === 0 ? -6 : 1 - dayOfWeek
  const weekStart = new Date(now)
  weekStart.setDate(now.getDate() + diffToMonday)
  weekStart.setHours(0, 0, 0, 0)
  const weekEnd = new Date(weekStart)
  weekEnd.setDate(weekStart.getDate() + 6)
  weekEnd.setHours(23, 59, 59, 999)
  return { weekStart, weekEnd }
}

async function buildChildGoals(studentId) {
  const { weekStart, weekEnd } = getCurrentWeekBounds()
  const [goal, wordsThisWeek, essaysThisWeek] = await Promise.all([
    WeeklyGoal.findOne({ student: studentId, weekStart }).lean(),
    countLearnedWords(studentId, weekStart, weekEnd),
    Essay.find({
      student: studentId,
      status: { $in: PARENT_VISIBLE_ESSAY_STATUSES },
      submittedAt: { $gte: weekStart, $lte: weekEnd },
    }).select('wordCount').lean(),
  ])

  if (!goal) {
    return {
      weekStart,
      weekEnd,
      goals: [],
      completionRate: 0,
      configured: false,
    }
  }

  const totalWordsWritten = essaysThisWeek.reduce((sum, essay) => sum + (essay.wordCount || 0), 0)
  const goals = goal.goals.map(item => {
    let current = item.current || 0
    if (item.label === 'New Words') current = wordsThisWeek
    if (item.label === 'Essays Written') current = essaysThisWeek.length
    if (item.label.includes('Writing Length')) current = totalWordsWritten
    return { ...item, current }
  })
  const completionRate = goals.length > 0
    ? Math.round(goals.reduce((sum, item) => sum + Math.min(1, item.target > 0 ? item.current / item.target : 0), 0) / goals.length * 100)
    : 0

  return {
    _id: goal._id,
    weekStart,
    weekEnd,
    goals,
    completionRate,
    configured: true,
  }
}

/**
 * @desc    Generate a one-time code that a parent can use to link this student
 * @route   POST /api/parent/link-code
 * @access  Private (student)
 */
export const createChildLinkCode = asyncHandler(async (req, res) => {
  await ChildLinkCode.deleteMany({ student: req.user._id, usedAt: null })

  const code = generateLinkCode()
  const expiresAt = new Date(Date.now() + LINK_CODE_TTL_MS)

  await ChildLinkCode.create({
    student: req.user._id,
    codeHash: hashLinkCode(code),
    expiresAt,
  })

  res.status(201).json({
    success: true,
    data: { code, expiresAt },
  })
})

/**
 * @desc    Get active parents and guardians linked to the current student
 * @route   GET /api/parent/guardians
 * @access  Private (student)
 */
export const getLinkedGuardians = asyncHandler(async (req, res) => {
  const links = await ParentStudentLink.find({
    student: req.user._id,
    status: 'active',
  })
    .populate('parent', 'name email avatar')
    .sort({ linkedAt: -1 })
    .lean()

  const guardians = links
    .filter(link => link.parent)
    .map(link => ({
      linkId: link._id,
      parent: {
        _id: link.parent._id,
        name: link.parent.name,
        email: maskEmail(link.parent.email),
        avatar: link.parent.avatar || '',
      },
      relationship: link.relationship,
      linkedAt: link.linkedAt,
    }))

  res.status(200).json({ success: true, data: guardians })
})

/**
 * @desc    Revoke a parent or guardian's access to the current student
 * @route   DELETE /api/parent/guardians/:linkId
 * @access  Private (student)
 */
export const unlinkGuardian = asyncHandler(async (req, res) => {
  const link = await ParentStudentLink.findOne({
    _id: req.params.linkId,
    student: req.user._id,
    status: 'active',
  })

  if (!link) {
    throw new ErrorResponse('Active guardian link not found', 404)
  }

  link.status = 'revoked'
  link.revokedAt = new Date()
  link.revokedBy = req.user._id
  await link.save()

  const repairs = await Promise.allSettled([
    User.updateOne({ _id: req.user._id }, { $pull: { parents: link.parent } }),
    User.updateOne({ _id: link.parent }, { $pull: { children: req.user._id } }),
  ])
  repairs.filter(result => result.status === 'rejected').forEach(result => {
    console.error('[Parent] Failed to repair denormalised guardian arrays:', result.reason?.message)
  })

  // The guardian may still have a live socket: remove it from this student's
  // notification, class, chat and essay-comment rooms immediately.
  await syncParentLinkedRooms(link.parent, { revokedStudentId: req.user._id })

  res.status(200).json({
    success: true,
    message: 'Guardian access removed successfully',
  })
})

/**
 * @desc    Link parent account to a student with a one-time code
 * @route   POST /api/parent/link
 * @access  Private (parent)
 */
export const linkChild = asyncHandler(async (req, res) => {
  const { linkCode, relationship = 'guardian' } = req.body
  const normalizedCode = String(linkCode || '').replace(/[\s-]/g, '').toUpperCase()

  if (normalizedCode.length !== LINK_CODE_LENGTH) {
    throw new ErrorResponse('Invalid or expired link code', 400)
  }

  if (!VALID_RELATIONSHIPS.includes(relationship)) {
    throw new ErrorResponse('Invalid relationship type', 400)
  }

  const codeHash = hashLinkCode(normalizedCode)
  const now = new Date()

  const claimedCode = await ChildLinkCode.findOneAndUpdate(
    {
      codeHash,
      usedAt: null,
      expiresAt: { $gt: now },
    },
    {
      $set: {
        usedAt: now,
        usedBy: req.user._id,
      },
    },
    { new: true }
  )

  if (!claimedCode) {
    const alreadyClaimed = await ChildLinkCode.findOne({ codeHash })

    if (alreadyClaimed && String(alreadyClaimed.usedBy) === String(req.user._id)) {
      const child = await User.findOne({ _id: alreadyClaimed.student, role: 'student' })
      if (!child) {
        throw new ErrorResponse('Invalid or expired link code', 400)
      }

      const usedAt = alreadyClaimed.usedAt ? new Date(alreadyClaimed.usedAt).getTime() : 0
      const recentlyClaimed = Date.now() - usedAt < LINK_REQUEST_GRACE_MS

      let existingLink = await ParentStudentLink.findOne({
        parent: req.user._id,
        student: child._id,
        status: 'active',
      })

      if (!existingLink && recentlyClaimed) {
        existingLink = await waitForActiveLink(req.user._id, child._id)
      }

      if (existingLink) {
        // The first request already linked this child. Repair the
        // denormalised arrays and return the same success payload so a
        // double-click / second device is idempotent.
        await Promise.all([
          User.updateOne({ _id: req.user._id }, { $addToSet: { children: child._id } }),
          User.updateOne({ _id: child._id }, { $addToSet: { parents: req.user._id } }),
        ])
        await syncParentLinkedRooms(req.user._id)
        return res.status(200).json(buildLinkSuccess(existingLink, child))
      }

      if (recentlyClaimed) {
        throw new ErrorResponse(
          'The link request is already being processed. Please wait a moment and refresh your linked students.',
          409
        )
      }
    }

    throw new ErrorResponse('Invalid or expired link code', 400)
  }

  try {
    const child = await User.findOne({ _id: claimedCode.student, role: 'student' })
    if (!child) {
      throw new ErrorResponse('Invalid or expired link code', 400)
    }

    const link = await activateParentStudentLink({
      parentId: req.user._id,
      studentId: child._id,
      relationship,
    })

    // Let an already-open parent socket join the new child's rooms.
    await syncParentLinkedRooms(req.user._id)

    res.status(200).json(buildLinkSuccess(link, child))
  } catch (error) {
    // Only release the one-time code when the link was not actually created.
    // A partial failure after creating the link must not make the code
    // reusable by another parent; retries take the idempotent branch above.
    let existingLink
    try {
      existingLink = await ParentStudentLink.findOne({
        parent: req.user._id,
        student: claimedCode.student,
        status: 'active',
      })
    } catch {
      existingLink = null
    }
    if (!existingLink) {
      await ChildLinkCode.updateOne(
        { _id: claimedCode._id, usedBy: req.user._id },
        { $set: { usedAt: null, usedBy: null } }
      ).catch(() => {})
    }
    throw error
  }
})

/**
 * @desc    Revoke one parent-student relationship
 * @route   DELETE /api/parent/children/:id/link
 * @access  Private (parent)
 */
export const unlinkChild = asyncHandler(async (req, res) => {
  const link = await ParentStudentLink.findOne({
    parent: req.user._id,
    student: req.params.id,
    status: 'active',
  })

  if (!link) {
    throw new ErrorResponse('Active child link not found', 404)
  }

  link.status = 'revoked'
  link.revokedAt = new Date()
  link.revokedBy = req.user._id
  await link.save()

  const repairs = await Promise.allSettled([
    User.updateOne({ _id: req.user._id }, { $pull: { children: req.params.id } }),
    User.updateOne({ _id: req.params.id }, { $pull: { parents: req.user._id } }),
  ])
  repairs.filter(result => result.status === 'rejected').forEach(result => {
    console.error('[Parent] Failed to repair denormalised child arrays:', result.reason?.message)
  })

  // Remove every connected session of this parent from the child's rooms
  // before returning, so notifications/chat/comments stop immediately.
  await syncParentLinkedRooms(req.user._id, { revokedStudentId: req.params.id })

  res.status(200).json({
    success: true,
    message: 'Child link revoked successfully',
  })
})

/**
 * @desc    Get linked children list
 * @route   GET /api/parent/children
 * @access  Private (parent)
 */
export const getChildren = asyncHandler(async (req, res) => {
  const links = await ParentStudentLink.find({
    parent: req.user._id,
    status: 'active',
  })
    .populate('student', 'name email avatar englishLevel')
    .sort({ linkedAt: -1 })
    .lean()

  const { weekStart: thisWeekStart, weekEnd: thisWeekEnd } = getCurrentWeekBounds()
  const lastWeekStart = new Date(thisWeekStart)
  lastWeekStart.setDate(thisWeekStart.getDate() - 7)

  const children = await Promise.all(links.filter(link => link.student).map(async link => {
    const child = link.student
    const [wordsThisWeek, wordsLastWeek, masteredWordSet, latestEssays, activeAlerts, goals, childClass] = await Promise.all([
      // Same definition as the child progress page and the "New Words" goal:
      // a word counts once it was reviewed or used, not merely saved.
      countLearnedWords(child._id, thisWeekStart, thisWeekEnd),
      countLearnedWords(child._id, lastWeekStart, new Date(thisWeekStart.getTime() - 1)),
      getMasteredWords(child._id),
      Essay.find({
        student: child._id,
        status: { $in: PARENT_VISIBLE_ESSAY_STATUSES },
      })
        .sort({ submittedAt: -1, createdAt: -1 })
        .limit(2)
        .select('title status submittedAt createdAt wordCount')
        .lean(),
      Alert.find({ student: child._id, isResolved: false }).select('type metric createdAt viewedByParents').lean(),
      buildChildGoals(child._id),
      Class.findOne({ students: child._id, status: 'active' }).populate('teacher', 'name').select('name teacher').lean(),
    ])

    const analyses = latestEssays.length > 0
      ? await AIAnalysis.find({ essay: { $in: latestEssays.map(essay => essay._id) } }).select('essay overallScore').lean()
      : []
    const analysisByEssay = new Map(analyses.map(analysis => [analysis.essay.toString(), analysis]))
    const latestScore = latestEssays[0] ? analysisByEssay.get(latestEssays[0]._id.toString())?.overallScore ?? null : null
    const previousScore = latestEssays[1] ? analysisByEssay.get(latestEssays[1]._id.toString())?.overallScore ?? null : null
    const scoreChange = latestScore !== null && previousScore !== null
      ? Math.round((latestScore - previousScore) * 10) / 10
      : null
    const hasCriticalAlert = activeAlerts.some(alert => alert.type === 'critical')
    const unreadAlertCount = activeAlerts.filter(alert =>
      !(alert.viewedByParents || []).some(parentId => parentId.toString() === req.user._id.toString())
    ).length
    const overallStatus = hasCriticalAlert
      ? 'needs_attention'
      : activeAlerts.length > 0 || wordsThisWeek === 0
        ? 'watch'
        : 'on_track'

    return {
      ...child,
      relationship: link.relationship,
      overallStatus,
      wordsThisWeek,
      wordsChange: wordsThisWeek - wordsLastWeek,
      masteredWords: masteredWordSet.size,
      latestScore,
      scoreChange,
      activeAlertCount: activeAlerts.length,
      unreadAlertCount,
      goalCompletionRate: goals.completionRate,
      goalsConfigured: goals.configured,
      latestEssay: latestEssays[0] || null,
      lastActivityAt: latestEssays[0]?.submittedAt || latestEssays[0]?.createdAt || null,
      className: childClass?.name || '',
      teacherName: childClass?.teacher?.name || '',
    }
  }))

  res.status(200).json({
    success: true,
    data: children,
  })
})

/**
 * @desc    Get current weekly goals for a linked child
 * @route   GET /api/parent/children/:id/goals
 * @access  Private (parent)
 */
export const getChildGoals = asyncHandler(async (req, res) => {
  await assertActiveChildLink(
    req.user._id,
    req.params.id,
    'Not authorized to view this child\'s goals',
  )

  const goals = await buildChildGoals(req.params.id)
  res.status(200).json({ success: true, data: goals })
})

/**
 * @desc    Get linked child progress overview
 * @route   GET /api/parent/children/:id/progress
 * @access  Private (parent)
 */
export const getChildProgress = asyncHandler(async (req, res) => {
  const childId = req.params.id
  await assertActiveChildLink(
    req.user._id,
    childId,
    'Not authorized to view this child\'s progress',
  )

  const totalVocab = await Vocabulary.countDocuments({ student: childId })
  const totalEssays = await Essay.countDocuments({
    student: childId,
    status: { $in: PARENT_VISIBLE_ESSAY_STATUSES },
  })

  const { weekStart: currentWeekStart } = getCurrentWeekBounds()
  const weeklyVocabulary = await Promise.all(
    Array.from({ length: 6 }, async (_, index) => {
      const weeksAgo = 5 - index
      const start = new Date(currentWeekStart)
      start.setDate(start.getDate() - weeksAgo * 7)
      const endExclusive = new Date(start)
      endExclusive.setDate(endExclusive.getDate() + 7)
      const count = await countLearnedWords(childId, start, new Date(endExclusive.getTime() - 1))
      return {
        start: start.toISOString(),
        end: new Date(endExclusive.getTime() - 1).toISOString(),
        count,
      }
    })
  )

  const essays = await Essay.find({
    student: childId,
    status: { $in: PARENT_VISIBLE_ESSAY_STATUSES },
  }).distinct('_id')
  const analyses = await AIAnalysis.find({ essay: { $in: essays } })

  const avgTTR = analyses.length > 0
    ? Math.round((analyses.reduce((sum, a) => sum + (a.scores?.vocabularyDiversity || 0), 0) / analyses.length) * 100) / 100
    : 0

  const child = await User.findById(childId)

  res.status(200).json({
    success: true,
    data: {
      totalVocab,
      totalEssays,
      avgTTR,
      englishLevel: child.englishLevel || '',
      weeklyVocabulary,
      name: child.name,
      email: child.email,
      avatar: child.avatar,
    }
  })
})

/**
 * @desc    Get linked child alerts
 * @route   GET /api/parent/children/:id/alerts
 * @access  Private (parent)
 */
export const getChildAlerts = asyncHandler(async (req, res) => {
  const childId = req.params.id
  await assertActiveChildLink(
    req.user._id,
    childId,
    'Not authorized to view this child\'s alerts',
  )

  const alerts = await Alert.find({ student: childId }).sort({ createdAt: -1 }).lean()
  const parentId = req.user._id.toString()
  const parentAlerts = alerts.map(alert => ({
    ...alert,
    detail: getParentAlertDetail(alert),
    isViewed: (alert.viewedByParents || []).some(viewerId => viewerId.toString() === parentId),
    viewedByParents: undefined,
  }))

  res.status(200).json({
    success: true,
    data: parentAlerts,
  })
})

/**
 * @desc    Mark a linked child's alert as viewed by the current parent
 * @route   PATCH /api/parent/children/:id/alerts/:alertId/viewed
 * @access  Private (parent)
 */
export const markChildAlertViewed = asyncHandler(async (req, res) => {
  await assertActiveChildLink(
    req.user._id,
    req.params.id,
    'Not authorized to update this child\'s alerts',
  )

  const alert = await Alert.findOne({ _id: req.params.alertId, student: req.params.id })
  if (!alert) {
    throw new ErrorResponse('Alert not found', 404)
  }

  const alreadyViewed = (alert.viewedByParents || []).some(parentId => parentId.toString() === req.user._id.toString())
  if (!alreadyViewed) {
    alert.viewedByParents = [...(alert.viewedByParents || []), req.user._id]
    await alert.save()
  }

  res.status(200).json({ success: true, data: { alertId: alert._id, isViewed: true } })
})

/**
 * @desc    Get linked child essay list
 * @route   GET /api/parent/children/:id/essays
 * @access  Private (parent)
 */
export const getChildEssays = asyncHandler(async (req, res) => {
  const childId = req.params.id
  await assertActiveChildLink(
    req.user._id,
    childId,
    'Not authorized to view this child\'s essays',
  )

  const essays = await Essay.find({
    student: childId,
    status: { $in: PARENT_VISIBLE_ESSAY_STATUSES },
  })
    .populate('assignment', 'title dueDate status')
    .sort({ submittedAt: -1, createdAt: -1 })
    .lean()
  const analyses = essays.length > 0
    ? await AIAnalysis.find({ essay: { $in: essays.map(essay => essay._id) } })
      .select('essay overallScore scores learningPatterns')
      .lean()
    : []
  const analysisByEssay = new Map(analyses.map(analysis => [analysis.essay.toString(), analysis]))
  const essaySummaries = essays.map(essay => ({
    ...essay,
    analysis: analysisByEssay.get(essay._id.toString()) || null,
  }))

  res.status(200).json({
    success: true,
    data: essaySummaries
  })
})

/**
 * @desc    Get vocabulary details of a child
 * @route   GET /api/parent/children/:id/vocabulary
 * @access  Private (parent)
 * @query   page, limit, category, mastery, sort
 */
export const getChildVocabulary = asyncHandler(async (req, res) => {
  const childId = req.params.id
  await assertActiveChildLink(
    req.user._id,
    childId,
    'Not authorized to view this child\'s vocabulary',
  )

  const { page = 1, limit = 20, category, mastery, sort = 'createdAt' } = req.query

  const query = { student: childId }
  const mastered = await getMasteredWords(childId)
  if (category && category !== 'all') query.category = category
  if (mastery && mastery !== 'all') {
    if (mastery === 'mastered') query.word = { $in: [...mastered] }
    else if (mastery === 'learning') {
      query.masteryLevel = { $in: ['learning', 'mastered'] }
      query.word = { $nin: [...mastered] }
    } else {
      query.masteryLevel = mastery
      query.word = { $nin: [...mastered] }
    }
  }

  const sortMap = {
    createdAt: { createdAt: -1 },
    word: { word: 1 },
    masteryLevel: { masteryLevel: 1 },
  }
  const sortObj = sortMap[sort] || { createdAt: -1 }

  const pageNum = Math.max(1, Number(page))
  const limitNum = Math.min(50, Math.max(1, Number(limit)))

  const [words, total] = await Promise.all([
    Vocabulary.find(query).sort(sortObj).skip((pageNum - 1) * limitNum).limit(limitNum).lean(),
    Vocabulary.countDocuments(query),
  ])

  const allWords = await Vocabulary.find({ student: childId }).lean()

  const masteryDistribution = { new: 0, learning: 0, mastered: 0 }
  const categoryMap = {}

  allWords.forEach(w => {
    const level = effectiveMastery(w, mastered)
    masteryDistribution[level] = (masteryDistribution[level] || 0) + 1
    if (!categoryMap[w.category]) categoryMap[w.category] = { total: 0, mastered: 0 }
    categoryMap[w.category].total++
    if (level === 'mastered') categoryMap[w.category].mastered++
  })

  const categoryStats = Object.entries(categoryMap).map(([name, stats]) => ({
    name: name.charAt(0).toUpperCase() + name.slice(1),
    key: name,
    total: stats.total,
    mastered: stats.mastered,
    progress: stats.total > 0 ? Math.round((stats.mastered / stats.total) * 100) : 0,
  }))

  const totalVocabulary = allWords.length
  const masteredCount = masteryDistribution.mastered
  const masteryRate = totalVocabulary > 0 ? Math.round((masteredCount / totalVocabulary) * 100) : 0

  res.status(200).json({
    success: true,
    data: { words: words.map((word) => withEffectiveMastery(word, mastered)), masteryDistribution, categoryStats, totalVocabulary, masteredCount, masteryRate },
    total,
    pages: Math.ceil(total / limitNum),
    page: pageNum,
    count: words.length,
  })
})
/* 
import Vocabulary from '../models/Vocabulary.js'
import User from '../models/User.js'
import Class from '../models/Class.js'
import Alert from '../models/Alert.js'
import Essay from '../models/Essay.js'
import AIAnalysis from '../models/AIAnalysis.js'
import asyncHandler from '../utils/asyncHandler.js'
import ErrorResponse from '../utils/ErrorResponse.js'
*/

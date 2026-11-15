import WeeklyGoal from '../models/WeeklyGoal.js'
import Essay from '../models/Essay.js'
import Vocabulary from '../models/Vocabulary.js'
import AIAnalysis from '../models/AIAnalysis.js'
import LearningSession from '../models/LearningSession.js'
import WordUsageEvidence from '../models/WordUsageEvidence.js'
import mongoose from 'mongoose'
import asyncHandler from '../utils/asyncHandler.js'
import ErrorResponse from '../utils/ErrorResponse.js'
import { validateGoalsArray } from '../utils/validateGoals.js'
import { dayBoundary } from '../utils/learning.js'

/**
 * Count new words genuinely learned this week (LEARN-04):
 * Only counts words that have reviewCount > 0 OR have verified usage evidence in WordUsageEvidence.
 * Words merely seeded into Vocabulary by starting a session with reviewCount === 0 are excluded.
 */
export async function countLearnedWords(studentId, start, end) {
  const candidateVocab = await Vocabulary.find({
    student: studentId,
    createdAt: { $gte: start, $lte: end },
  }).select('word reviewCount').lean()

  const reviewedWordSet = new Set()
  const candidateUnreviewed = []

  for (const v of candidateVocab) {
    const w = (v.word || '').trim().toLowerCase()
    if (!w) continue
    if (v.reviewCount > 0) {
      reviewedWordSet.add(w)
    } else {
      candidateUnreviewed.push(w)
    }
  }

  let evidenceForCandidates = []
  if (candidateUnreviewed.length > 0) {
    evidenceForCandidates = await WordUsageEvidence.distinct('word', {
      student: studentId,
      word: { $in: candidateUnreviewed },
    })
  }

  const evidenceThisWeek = await WordUsageEvidence.distinct('word', {
    student: studentId,
    $or: [
      { usedAt: { $gte: start, $lte: end } },
      { createdAt: { $gte: start, $lte: end } },
    ],
  })

  const learnedWords = new Set([
    ...reviewedWordSet,
    ...evidenceForCandidates.map((w) => (w || '').trim().toLowerCase()),
    ...evidenceThisWeek.map((w) => (w || '').trim().toLowerCase()),
  ])

  return learnedWords.size
}

/**
 * Get the start and end of week (Monday to Sunday) using student timezone (LEARN-20)
 */
export function getWeekBounds(zone = 'Asia/Ho_Chi_Minh', now = new Date()) {
  try {
    const weekday = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      weekday: 'short',
    }).format(now)

    const dayMap = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 }
    const daysSinceMonday = dayMap[weekday] ?? 0

    const weekStart = dayBoundary(now, -daysSinceMonday, zone)
    const nextMondayStart = dayBoundary(now, 7 - daysSinceMonday, zone)
    const weekEnd = new Date(nextMondayStart.getTime() - 1)

    return { weekStart, weekEnd }
  } catch {
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
}

/**
 * @desc    Get current week goals
 * @route   GET /api/goals
 * @access  Private (student)
 */
export const getCurrentGoals = asyncHandler(async (req, res) => {
  const zone = req.user.learningProfile?.timezone || 'Asia/Ho_Chi_Minh'
  const { weekStart, weekEnd } = getWeekBounds(zone)
  let goal = await WeeklyGoal.findOne({ student: req.user._id, weekStart })

  if (!goal) {
    // Auto-create default goals for this week
    goal = await WeeklyGoal.create({
      student: req.user._id,
      weekStart,
      weekEnd,
      goals: [
        { label: 'New Words', target: 20, current: 0, icon: 'dictionary', color: 'primary' },
        { label: 'Essays Written', target: 3, current: 0, icon: 'edit_note', color: 'secondary' },
        { label: 'Writing Length (words)', target: 5000, current: 0, icon: 'text_fields', color: 'tertiary' },
        { label: 'Complexity Score', target: 8, current: 0, icon: 'equalizer', color: 'primary' },
      ],
    })
  }

  // Calculate current progress from real data (LEARN-04: only truly learned words)
  const newWordsThisWeek = await countLearnedWords(req.user._id, weekStart, weekEnd)

  const essaysThisWeek = await Essay.find({
    student: req.user._id,
    status: { $ne: 'draft' },
    submittedAt: { $gte: weekStart, $lte: weekEnd },
  })

  const totalWordsWritten = essaysThisWeek.reduce((sum, e) => sum + (e.wordCount || 0), 0)

  // LEARN-20: Calculate average complexity score from AI analyses of this week's essays
  const essayIds = essaysThisWeek.map((e) => e._id).filter(Boolean)
  const analyses = essayIds.length > 0
    ? await AIAnalysis.find({ essay: { $in: essayIds } }).select('scores').lean()
    : []
  const validComplexityScores = analyses
    .map((a) => a.scores?.complexityIndex)
    .filter((score) => typeof score === 'number' && !isNaN(score))
  const avgComplexity = validComplexityScores.length > 0
    ? validComplexityScores.reduce((sum, val) => sum + val, 0) / validComplexityScores.length
    : 0

  // Update current progress
  goal.goals = goal.goals.map(g => {
    if (g.label === 'New Words') return { ...g.toObject(), current: newWordsThisWeek }
    if (g.label === 'Essays Written') return { ...g.toObject(), current: essaysThisWeek.length }
    if (g.label.includes('Writing Length')) return { ...g.toObject(), current: totalWordsWritten }
    if (g.label === 'Complexity Score') return { ...g.toObject(), current: Math.round(avgComplexity * 10) / 10 }
    return g
  })
  await goal.save()

  res.status(200).json({ success: true, data: goal })
})

/**
 * @desc    Create goals for the current week
 * @route   POST /api/goals
 * @access  Private (student)
 */
export const createGoals = asyncHandler(async (req, res) => {
  const zone = req.user.learningProfile?.timezone || 'Asia/Ho_Chi_Minh'
  const { weekStart, weekEnd } = getWeekBounds(zone)

  const existing = await WeeklyGoal.findOne({ student: req.user._id, weekStart })
  if (existing) {
    throw new ErrorResponse('Goals already exist for this week. Use PUT to update.', 400)
  }

  const goals = validateGoalsArray(req.body.goals)

  const goal = await WeeklyGoal.create({
    student: req.user._id,
    weekStart,
    weekEnd,
    goals,
  })

  res.status(201).json({ success: true, data: goal })
})

/**
 * @desc    Update goal targets
 * @route   PUT /api/goals/:id
 * @access  Private (student)
 */
export const updateGoals = asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) {
    throw new ErrorResponse('Invalid goal id', 400)
  }
  const goal = await WeeklyGoal.findOne({ _id: req.params.id, student: req.user._id })

  if (!goal) {
    throw new ErrorResponse('Goals not found', 404)
  }

  if (req.body.goals === undefined) {
    throw new ErrorResponse('Goals array is required', 400)
  }
  goal.goals = validateGoalsArray(req.body.goals)
  await goal.save()

  res.status(200).json({ success: true, data: goal })
})

/**
 * @desc    Get AI recommendations for goals (grounded in last-week data)
 * @route   GET /api/goals/recommendations
 * @access  Private (student)
 */
export const getRecommendations = asyncHandler(async (req, res) => {
  const zone = req.user.learningProfile?.timezone || 'Asia/Ho_Chi_Minh'
  const { weekStart } = getWeekBounds(zone)
  const lastWeekEnd = new Date(weekStart.getTime() - 1)
  const { weekStart: lastWeekStart } = getWeekBounds(zone, new Date(weekStart.getTime() - 86400000))

  const [lastWeekGoal, newWordsLastWeek, essaysLastWeek, totalVocab, totalEssays, sessions] = await Promise.all([
    WeeklyGoal.findOne({ student: req.user._id, weekStart: lastWeekStart }).lean(),
    countLearnedWords(req.user._id, lastWeekStart, lastWeekEnd),
    Essay.find({ student: req.user._id, status: { $ne: 'draft' }, submittedAt: { $gte: lastWeekStart, $lte: lastWeekEnd } }).select('wordCount').lean(),
    Vocabulary.countDocuments({ student: req.user._id }),
    Essay.countDocuments({ student: req.user._id, status: { $ne: 'draft' } }),
    LearningSession.find({ student: req.user._id, createdAt: { $gte: lastWeekStart, $lte: lastWeekEnd } }).select('activeTimeSeconds').lean(),
  ])

  const wordsWrittenLastWeek = essaysLastWeek.reduce((sum, e) => sum + (e.wordCount || 0), 0)
  const essayIds = essaysLastWeek.map((e) => e._id).filter(Boolean)
  const analyses = essayIds.length > 0
    ? await AIAnalysis.find({ essay: { $in: essayIds } }).select('scores').lean()
    : []
  const avgTTR = analyses.length > 0
    ? analyses.reduce((sum, a) => sum + (a.scores?.vocabularyDiversity || 0), 0) / analyses.length
    : 0
  const avgComplexity = analyses.length > 0
    ? analyses.reduce((sum, a) => sum + (a.scores?.complexityIndex || 0), 0) / analyses.length
    : 0
  const studyMinutesLastWeek = Math.round(sessions.reduce((sum, s) => sum + (s.activeTimeSeconds || 0), 0) / 60)

  const { summarizeMetrics, generateAIGoalRecommendations } = await import('../services/goalsRecommendation.service.js')
  const metrics = summarizeMetrics({
    lastWeekGoal,
    newWordsLastWeek,
    essaysLastWeek: essaysLastWeek.length,
    wordsWrittenLastWeek,
    avgTTR: Math.round(avgTTR * 100) / 100,
    avgComplexity: Math.round(avgComplexity * 100) / 100,
    studyMinutesLastWeek,
    totalVocab,
    totalEssays,
  })

  const { recommendations, source, reason } = await generateAIGoalRecommendations(req.user, metrics)

  // data stays an ARRAY for backward compat with SetWeeklyGoals.jsx;
  // source/reason/metrics are new top-level transparency fields.
  res.status(200).json({ success: true, source, reason, metrics, data: recommendations })
})

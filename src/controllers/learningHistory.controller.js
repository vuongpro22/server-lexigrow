import asyncHandler from '../utils/asyncHandler.js'
import LearningSession from '../models/LearningSession.js'
import Vocabulary from '../models/Vocabulary.js'
import PracticeAttempt from '../models/PracticeAttempt.js'
import { publicLearning } from '../utils/learning.js'
import { effectiveMastery, getMasteredWords } from '../services/masteryView.service.js'

/**
 * Get learning history for AI recommendation
 * Returns: completed sessions, words learned, mastery stats
 */
export const getLearningHistory = asyncHandler(async (req, res) => {
  const studentId = req.user._id

  // Get completed sessions
  const sessions = await LearningSession.find({
    student: studentId,
    status: 'completed',
  })
    .sort({ completedAt: -1 })
    .limit(50)
    .lean()

  // Get vocabulary stats (mastery comes from verified essay evidence)
  const [vocabWords, masteredWords] = await Promise.all([
    Vocabulary.find({ student: studentId }).select('word masteryLevel').lean(),
    getMasteredWords(studentId),
  ])

  const masteryStats = {
    new: 0,
    learning: 0,
    mastered: 0,
  }
  for (const word of vocabWords) {
    const level = effectiveMastery(word, masteredWords)
    if (level in masteryStats) masteryStats[level] += 1
  }

  // Get recent practice attempts (last 30 days)
  const thirtyDaysAgo = new Date()
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30)
  const recentPractice = await PracticeAttempt.find({
    student: studentId,
    createdAt: { $gte: thirtyDaysAgo },
  })
    .sort({ createdAt: -1 })
    .limit(100)
    .lean()

  const practiceStats = {
    total: recentPractice.length,
    correct: recentPractice.filter((p) => p.isCorrect).length,
    accuracy: recentPractice.length > 0
      ? Math.round((recentPractice.filter((p) => p.isCorrect).length / recentPractice.length) * 100)
      : 0,
  }

  // Get daily activity (count sessions per day)
  const dailyActivity = []
  const sessionMap = {}
  sessions.forEach((s) => {
    const date = s.completedAt ? s.completedAt.toISOString().split('T')[0] : null
    if (date) {
      sessionMap[date] = (sessionMap[date] || 0) + 1
    }
  })
  Object.keys(sessionMap)
    .sort()
    .forEach((date) => {
      dailyActivity.push({ date, sessions: sessionMap[date] })
    })

  // Extract topics from sessions
  const topics = {}
  sessions.forEach((s) => {
    if (s.theme) {
      topics[s.theme] = (topics[s.theme] || 0) + 1
    }
  })
  const topTopics = Object.entries(topics)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([topic, count]) => ({ topic, count }))

  res.json({
    success: true,
    data: {
      totalSessions: sessions.length,
      totalWords: masteryStats.new + masteryStats.learning + masteryStats.mastered,
      masteryStats,
      practiceStats,
      dailyActivity: dailyActivity.slice(-30),
      topTopics,
      recentSessions: sessions.slice(0, 10).map(publicLearning),
      hasHistory: sessions.length > 0,
    },
  })
})

/**
 * Get exact per-slug completed-session counts for the current student.
 * Used by the Explore page to show "Round N" badges on topic cards.
 * Returns: { counts: { [slug]: completedCount } }
 * Note: adaptive sessions (learningSetSlug = null) are excluded because
 *       they don't map to a specific topic card on the Explore page.
 */
export const getRoundCounts = asyncHandler(async (req, res) => {
  const studentId = req.user._id
  const sessionFilter = req.user.role === 'admin' ? {} : { student: studentId }

  const aggregated = await LearningSession.aggregate([
    {
      $match: {
        ...sessionFilter,
        status: 'completed',
        learningSetSlug: { $ne: null },
      },
    },
    { $group: { _id: '$learningSetSlug', count: { $sum: 1 } } },
  ])

  const counts = {}
  for (const row of aggregated) {
    if (row._id) counts[row._id] = row.count
  }

  res.json({ success: true, data: { counts } })
})

export default {
  getLearningHistory,
  getRoundCounts,
}
import { Router } from 'express'
import mongoose from 'mongoose'
import { protect, authorize } from '../middleware/auth.middleware.js'
import { gamePlayRateLimiter, gameSubmitRateLimiter, gameAIRecommendationLimiter } from '../middleware/gameRateLimit.middleware.js'
import asyncHandler from '../utils/asyncHandler.js'
import ErrorResponse from '../utils/ErrorResponse.js'
import DailyQuest from '../models/DailyQuest.js'
import Vocabulary from '../models/Vocabulary.js'
import GlobalVocabulary from '../models/GlobalVocabulary.js'
import { generateCrossword, STARTER_WORDS, questDay, questDaysInPlay } from '../services/crossword.service.js'
import { questXpReward } from '../services/dailyQuest.service.js'
import { applyPlay, publicQuest } from '../services/dailyQuest.service.js'
import { awardDailyQuestXp, getFireflyBalance } from '../services/gamification.service.js'
import { XP_RULES } from '../constants/gamification.js'

/**
 * Standardized transparency metadata (sibling of `data`, following the
 * repo's pagination/count/correct convention). Additive — old clients
 * reading only `data` are unaffected.
 */
function questMeta(source, sourceReason = '') {
  const normalized = source === 'ai' || source === 'mixed' ? source : 'fallback'
  return { source: normalized, isFallback: normalized === 'fallback', reason: sourceReason || '' }
}

const router = Router()
router.use(protect, authorize('student'))
router.use(gamePlayRateLimiter)

router.get(
  '/summary',
  asyncHandler(async (req, res) => {
    const [today, fireflies] = await Promise.all([
      DailyQuest.findOne({ student: req.user._id, day: questDay() })
        .select('startedAt completedAt solved words revealed source sourceReason')
        .lean(),
      getFireflyBalance(req.user._id),
    ])
    res.json({
      success: true,
      data: {
        fireflies,
        xpReward: questXpReward(today?.revealed),
        status: today?.completedAt ? 'completed' : today?.startedAt ? 'playing' : 'new',
        solved: today?.solved.length || 0,
        total: today?.words.length || 6,
        source: today?.source || null,
        sourceReason: today?.sourceReason || '',
      },
      _meta: questMeta(today?.source, today?.sourceReason),
    })
  }),
)

router.post(
  '/today',
  gameAIRecommendationLimiter,
  asyncHandler(async (req, res) => {
    const day = questDay(),
      filter = { student: req.user._id, day }
    let quest = await DailyQuest.findOne(filter).lean()
    if (!quest) {
      const now = new Date()
      // Try AI-generated words first, fallback to rule-based
    let aiWords = []
    let aiError = ''
    try {
      const { generateAIDailyQuestWords } = await import('../services/aiRecommendation.service.js')
      const dueWords = await Vocabulary.find({
        student: req.user._id,
        $or: [{ nextReviewDate: null }, { nextReviewDate: { $lte: now } }],
      })
        .sort({ nextReviewDate: 1, createdAt: -1 })
        .limit(20)
        .lean()
      const recentWords = await Vocabulary.find({ student: req.user._id })
        .sort({ createdAt: -1 })
        .limit(15)
        .lean()
      aiWords = await generateAIDailyQuestWords(
        req.user,
        recentWords,
        dueWords,
        6,
        `${req.user._id}:${day}`
      )
    } catch (err) {
      aiError = err.message
      console.error('AI daily quest generation failed, falling back to rule-based:', err.message)
    }

    let candidates
    if (aiWords && aiWords.length >= 4) {
      // Convert AI words to the format expected by generateCrossword
      candidates = aiWords.map(w => ({
        word: w.word,
        definition: w.definition,
        translation: w.translation,
        exampleSentence: w.exampleSentence,
        source: 'ai'
      }))
      // Add some starter words for variety
      const shuffledStarters = [...STARTER_WORDS].sort(() => Math.random() - 0.5).slice(0, 2)
      candidates = [...candidates, ...shuffledStarters]
    } else {
      const [due, recent, global] = await Promise.all([
        Vocabulary.find({
          student: req.user._id,
          $or: [{ nextReviewDate: null }, { nextReviewDate: { $lte: now } }],
        })
          .sort({ nextReviewDate: 1, createdAt: -1 })
          .limit(40)
          .lean(),
        Vocabulary.find({ student: req.user._id }).sort({ createdAt: -1 }).limit(30).lean(),
        GlobalVocabulary.find({ cefr: req.user.learningProfile?.targetLevel || 'B1' })
          .sort({ word: 1 })
          .limit(30)
          .lean(),
      ])
      candidates = [
        ...due,
        ...recent,
        ...global.map((w) => ({ ...w, source: 'library' })),
        ...STARTER_WORDS,
      ]
    }
    let puzzle = generateCrossword(candidates, `${req.user._id}:${day}`)
    if (puzzle.words.length < 5)
      puzzle = generateCrossword(STARTER_WORDS, `${req.user._id}:${day}`)
    // Quest-level source transparency derived from per-word sources
    const aiCount = puzzle.words.filter((w) => w.source === 'ai').length
    const questSource = aiCount === puzzle.words.length && aiCount > 0
      ? 'ai'
      : aiCount > 0
        ? 'mixed'
        : 'fallback'
    const questSourceReason = questSource === 'fallback'
      ? (aiError ? `AI failed: ${aiError} — rule-based words used` : 'AI returned fewer than 4 words — rule-based words used')
      : questSource === 'mixed'
        ? `AI provided ${aiCount}/${puzzle.words.length} words, rest are starter words`
        : `All ${puzzle.words.length} words generated by AI`
      try {
        quest = (await DailyQuest.create({ ...filter, ...puzzle, source: questSource, sourceReason: questSourceReason })).toObject({ flattenMaps: true })
      } catch (error) {
        if (error.code !== 11000) throw error
        quest = await DailyQuest.findOne(filter).lean()
      }
    }
    res.json({ success: true, data: publicQuest(quest), _meta: questMeta(quest.source, quest.sourceReason) })
  }),
)

router.post(
  '/:id/play',
  gameSubmitRateLimiter,
  asyncHandler(async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) throw new ErrorResponse('Quest not found', 404)
    const filter = { _id: req.params.id, student: req.user._id }
    const quest = await DailyQuest.findOne(filter).lean()
    if (!quest) throw new ErrorResponse('Quest not found', 404)
    // A lost completion response can be retried without another reward. The
    // XP helper is idempotent, so it also repairs a completion whose reward
    // write was interrupted.
    if (quest.completedAt) {
      const rewards = await awardDailyQuestXp(req.user._id, quest)
      return res.json({
        success: true,
        data: publicQuest(quest),
        correct: true,
        xpEarned: rewards.xpEarned,
        totalXp: rewards.totalXp,
        level: rewards.level,
        levelName: rewards.levelName,
        nextLevelXp: rewards.nextLevelXp,
        progressPercent: rewards.progressPercent,
        levelUp: rewards.levelUp,
        newBadges: rewards.newBadges,
        newRewards: rewards.newRewards,
        _meta: questMeta(quest.source, quest.sourceReason),
      })
    }
    if (!questDaysInPlay().includes(quest.day))
      return res
        .status(410)
        .json({ error: 'This quest has ended. Open today’s quest.', code: 'QUEST_EXPIRED' })
    if (req.body.revision !== quest.revision)
      return res
        .status(409)
        .json({
          error: 'Quest changed on another tab. Reload to continue.',
          code: 'QUEST_CONFLICT',
        })
    const { update, correct } = applyPlay(quest, req.body)
    const updated = await DailyQuest.findOneAndUpdate(
      { ...filter, revision: quest.revision, completedAt: { $exists: false } },
      { $set: update, $inc: { revision: 1 } },
      { returnDocument: 'after' },
    ).lean()
    if (!updated)
      return res
        .status(409)
        .json({
          error: 'Quest changed on another tab. Reload to continue.',
          code: 'QUEST_CONFLICT',
        })
    const rewards = updated.completedAt
      ? await awardDailyQuestXp(req.user._id, updated)
      : null
    res.json({
      success: true,
      data: publicQuest(updated),
      correct,
      xpEarned: rewards?.xpEarned || 0,
      totalXp: rewards?.totalXp,
      level: rewards?.level,
      levelName: rewards?.levelName,
      nextLevelXp: rewards?.nextLevelXp,
      progressPercent: rewards?.progressPercent,
      levelUp: rewards?.levelUp || null,
      newBadges: rewards?.newBadges || [],
      newRewards: rewards?.newRewards || [],
      _meta: questMeta(updated.source, updated.sourceReason),
    })
  }),
)

export default router

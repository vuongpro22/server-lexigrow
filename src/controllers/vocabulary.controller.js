import Vocabulary from '../models/Vocabulary.js'
import ReviewEvent from '../models/ReviewEvent.js'
import asyncHandler from '../utils/asyncHandler.js'
import { awardVocabularyReviewXp, vocabularyReviewJobKey } from '../services/learningXp.service.js'
import { calculateSM2, sm2Quality } from '../services/srs.service.js'
import { transactIntent } from '../services/learningTransaction.service.js'
import { dayBoundary, dayKey, escapeRegex, integer } from '../utils/learning.js'
import { effectiveMastery, getMasteredWords, withEffectiveMastery } from '../services/masteryView.service.js'
import { enrichVocabularyWord } from '../services/vocabularyEnrichment.service.js'

/**
 * @desc    Get student's vocabulary library
 * @route   GET /api/vocabulary
 * @access  Private (student)
 */
export const getVocabulary = asyncHandler(async (req, res) => { // lấy ds từ vựng 
  const page = integer(req.query.page, 1, 1, 100000)
  const limit = integer(req.query.limit, 50, 1, 200)
  const { category, mastery, theme, search } = req.query
  const query = { student: req.user._id }

  if (category) query.category = category
  if (theme) query.theme = { $regex: escapeRegex(theme), $options: 'i' }
  if (mastery && mastery !== 'mastered') {
    // A stored 'mastered' row without evidence is displayed as learning, so the
    // learning filter must include those rows too.
    query.masteryLevel = mastery === 'learning' ? { $in: ['learning', 'mastered'] } : mastery
  }

  // "mastered" is derived from verified essay evidence, not from the stored
  // recognition level, so the filter and the returned level share one source.
  const mastered = await getMasteredWords(req.user._id)
  const conditions = []
  if (search) conditions.push({ word: { $regex: escapeRegex(search), $options: 'i' } })
  if (mastery === 'mastered') conditions.push({ word: { $in: [...mastered] } })
  else if (mastery) conditions.push({ word: { $nin: [...mastered] } })
  if (conditions.length) query.$and = conditions

  const now = new Date()
  const zone = req.user.learningProfile?.timezone || 'Asia/Ho_Chi_Minh'
  // Use the same local-day boundary as GET /vocabulary/due-today so the badge
  // and the review deck always agree.
  const startOfTomorrow = dayBoundary(now, 1, zone)
  const [words, total, themes, dueCount] = await Promise.all([
    Vocabulary.find(query)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(Number(limit)),
    Vocabulary.countDocuments(query),
    Vocabulary.distinct('theme', { student: req.user._id }),
    Vocabulary.countDocuments({
      student: req.user._id,
      ...(category ? { category } : {}),
      $or: [
        { nextReviewDate: null },
        { nextReviewDate: { $lt: startOfTomorrow } },
      ],
    }),
  ])

  res.status(200).json({
    success: true,
    count: words.length,
    total,
    page: Number(page),
    pages: Math.ceil(total / limit) || 1,
    limit: Number(limit),
    themes: (themes || []).filter(Boolean),
    dueCount: dueCount || 0,
    data: words.map((word) => withEffectiveMastery(word, mastered)),
  })
})

/**
 * @desc    Add new vocabulary manually
 * @route   POST /api/vocabulary
 * @access  Private (student)
 */
export const createVocabulary = asyncHandler(async (req, res) => { // hàm xử lsy logic thêm từ vựng thủ công và kiểm tra xem đã có từ đó chưa
  // Mastery is never accepted from the client: a word starts as 'new' and can
  // only progress through reviews and verified essay evidence.
  const { word, category, theme } = req.body

  if (!word) {
    throw new (await import('../utils/ErrorResponse.js')).default('Please provide a word', 400)
  }

  const normalizedWord = word.trim().toLowerCase()

  // Check if word already exists for this student
  let existing = await Vocabulary.findOne({ student: req.user._id, word: normalizedWord })
  if (existing) {
    throw new (await import('../utils/ErrorResponse.js')).default('Word already exists in your library', 400)
  }

  // Check if this word was already enriched by ANY student in the system to save AI tokens
  const existingEnriched = await Vocabulary.findOne({
    word: normalizedWord,
    definition: { $ne: '' }
  }).select('ipa partOfSpeech definition exampleSentence synonyms antonyms')

  let enriched = {}
  if (existingEnriched) {
    enriched = {
      ipa: existingEnriched.ipa,
      partOfSpeech: existingEnriched.partOfSpeech,
      definition: existingEnriched.definition,
      exampleSentence: existingEnriched.exampleSentence,
      synonyms: existingEnriched.synonyms,
      antonyms: existingEnriched.antonyms,
    }
  }

  const newWord = await Vocabulary.create({
    word: normalizedWord,
    student: req.user._id,
    category: category || 'daily',
    theme: theme || 'General',
    masteryLevel: 'new',
    enrichmentStatus: existingEnriched ? 'done' : 'pending',
    ipa: enriched.ipa || '',
    partOfSpeech: enriched.partOfSpeech || '',
    definition: enriched.definition || '',
    exampleSentence: enriched.exampleSentence || '',
    synonyms: enriched.synonyms || [],
    antonyms: enriched.antonyms || [],
  })

  // Enrichment runs after the response so a slow provider cannot block the
  // add-word request. The word is usable immediately and filled in shortly.
  if (!existingEnriched) {
    setImmediate(() => {
      enrichVocabularyWord(newWord._id, normalizedWord)
    })
  }

  res.status(201).json({ success: true, data: newWord })
})

/**
 * @desc    Get vocabulary stats by category
 * @route   GET /api/vocabulary/stats
 * @access  Private (student)
 */
export const getVocabStats = asyncHandler(async (req, res) => {
  const [words, mastered] = await Promise.all([
    Vocabulary.find({ student: req.user._id }).select('word category masteryLevel').lean(),
    getMasteredWords(req.user._id),
  ])

  const total = words.length
  const categories = ['academic', 'business', 'scientific', 'daily'].map(cat => {
    const inCategory = words.filter(word => word.category === cat)
    return {
      name: cat.charAt(0).toUpperCase() + cat.slice(1),
      category: cat,
      count: inCategory.length,
      mastered: inCategory.filter(
        word => effectiveMastery(word, mastered) === 'mastered',
      ).length,
      progress: total > 0 ? Math.round((inCategory.length / total) * 100) : 0,
    }
  })

  // Mastery distribution is derived from the same evidence pipeline as every
  // other screen, so the library and the garden always agree.
  const masteryDistribution = { new: 0, learning: 0, mastered: 0 }
  for (const word of words) {
    const level = effectiveMastery(word, mastered)
    if (level in masteryDistribution) masteryDistribution[level] += 1
  }

  res.status(200).json({ success: true, total, data: categories, masteryDistribution })
})

/**
 * @desc    Get vocabulary growth data over time
 * @route   GET /api/vocabulary/growth
 * @access  Private (student)
 */
export const getVocabGrowth = asyncHandler(async (req, res) => {
  const { period = 'weekly' } = req.query
  const now = new Date()
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

  if (period === 'monthly') {
    // Last 6 months
    const dates = []
    for (let i = 5; i >= 0; i--) {
      const d = new Date(now)
      d.setMonth(now.getMonth() - i)
      // Set to end of the month
      d.setDate(new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate())
      d.setHours(23, 59, 59, 999)
      dates.push({
        date: d,
        label: `${monthNames[d.getMonth()]} ${d.getFullYear()}`
      })
    }

    const data = await Promise.all(
      dates.map(async (item) => {
        const count = await Vocabulary.countDocuments({
          student: req.user._id,
          createdAt: { $lte: item.date }
        })
        return {
          label: item.label,
          count
        }
      })
    )

    res.status(200).json({ success: true, data })
  } else {
    // Weekly (default): last 4 weeks
    const dates = []
    for (let i = 3; i >= 0; i--) {
      const d = new Date(now)
      d.setDate(now.getDate() - i * 7)
      d.setHours(23, 59, 59, 999)
      dates.push({
        date: d,
        label: i === 0 ? `${monthNames[d.getMonth()]} ${d.getDate()} (Today)` : `${monthNames[d.getMonth()]} ${d.getDate()}`
      })
    }

    const data = await Promise.all(
      dates.map(async (item) => {
        const count = await Vocabulary.countDocuments({
          student: req.user._id,
          createdAt: { $lte: item.date }
        })
        return {
          label: item.label,
          count
        }
      })
    )

    res.status(200).json({ success: true, data })
  }
})

/**
 * @desc    Update vocabulary mastery level
 * @route   PATCH /api/vocabulary/:id
 * @access  Private (student)
 */
export const updateMastery = asyncHandler(async (req, res) => {
  const ErrorResponse = (await import('../utils/ErrorResponse.js')).default

  const word = await Vocabulary.findOne({ _id: req.params.id, student: req.user._id })

  if (!word) {
    throw new ErrorResponse('Word not found', 404)
  }

  // If masteryLevel is not provided in the body, return word unchanged (no save)
  if (!('masteryLevel' in req.body)) {
    return res.status(200).json({ success: true, data: word })
  }

  const requested = req.body.masteryLevel
  const VALID_LEVELS = ['new', 'learning', 'mastered']

  // Reject invalid / non-enum values (null, numbers, wrong strings, etc.)
  if (!VALID_LEVELS.includes(requested)) {
    throw new ErrorResponse(
      `Invalid masteryLevel. Allowed values: ${VALID_LEVELS.join(', ')}`,
      400,
    )
  }

  // Evidence-based protection: any manual transition that involves 'mastered'
  // (either entering or leaving it) is forbidden via this endpoint.
  // Mastery must be earned / lost exclusively through the SRS review system.
  if (requested === 'mastered' || word.masteryLevel === 'mastered') {
    throw new ErrorResponse(
      'Mastery level cannot be changed manually. It is managed exclusively by the SRS review system.',
      403,
    )
  }

  // Idempotent: if nothing changes, skip save and return immediately
  if (requested === word.masteryLevel) {
    return res.status(200).json({ success: true, data: word })
  }

  word.masteryLevel = requested
  await word.save()

  res.status(200).json({ success: true, data: word })
})

/**
 * @desc    Get vocabulary due for review today (SRS)
 * @route   GET /api/vocabulary/due-today
 * @access  Private (student)
 *
 * A word is "due today" when:
 *   - nextReviewDate is null (never reviewed yet), OR
 *   - nextReviewDate <= now
 *
 * Supports optional `limit` (default 20, max 200) and `category` query params.
 */
export const getDueToday = asyncHandler(async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 200)
  const zone = req.user.learningProfile?.timezone || 'Asia/Ho_Chi_Minh'
  // "Due today" ends at the student's local midnight, not the server's: a word
  // scheduled for tomorrow must not appear early for users in another zone.
  const startOfTomorrow = dayBoundary(new Date(), 1, zone)
  const query = {
    student: req.user._id,
    $or: [
      { nextReviewDate: null },
      { nextReviewDate: { $lt: startOfTomorrow } },
    ],
  }
  if (req.query.category) query.category = req.query.category

  const [words, mastered] = await Promise.all([
    Vocabulary.find(query)
      .sort({ nextReviewDate: 1, createdAt: 1 })
      .limit(limit),
    getMasteredWords(req.user._id),
  ])

  res.status(200).json({
    success: true,
    count: words.length,
    timezone: zone,
    data: words.map((word) => withEffectiveMastery(word, mastered)),
  })
})

/**
 * @desc    Submit a flashcard review (SM-2 spaced repetition)
 * @route   POST /api/vocabulary/review
 * @access  Private (student)
 *
 * Body: { wordId: string, rating: 1|2|3|4 }
 *   1 = again (forgot)
 *   2 = hard
 *   3 = good
 *   4 = easy
 *
 * Implements the SM-2 algorithm to schedule the next review.
 * Mastery level is also promoted/demoted based on streak.
 */
export const reviewVocabulary = asyncHandler(async (req, res) => {
  const ErrorResponse = (await import('../utils/ErrorResponse.js')).default
  const { wordId, rating } = req.body
  if (!wordId) throw new ErrorResponse('wordId is required', 400)
  const r = parseInt(rating, 10)
  if (![1, 2, 3, 4].includes(r)) {
    throw new ErrorResponse('rating must be 1, 2, 3, or 4', 400)
  }

  const zone = req.user.learningProfile?.timezone || 'Asia/Ho_Chi_Minh'
  const now = new Date()
  // Every review is an idempotent intent: a double click or a retried request
  // returns the stored outcome instead of scheduling (and paying XP) twice.
  const headerKey = req.get('Idempotency-Key') || req.body.requestId
  const requestId =
    String(headerKey || '').trim() || `${wordId}:${r}:${dayKey(now, zone)}`
  if (requestId.length > 128) throw new ErrorResponse('Invalid Idempotency-Key', 400)

  const out = await transactIntent(
    req.user._id,
    'vocabulary_review',
    requestId,
    { wordId: String(wordId), rating: r },
    async (tx) => {
      const word = await Vocabulary.findOne({
        _id: wordId,
        student: req.user._id,
      }).session(tx)
      if (!word) throw new ErrorResponse('Word not found', 404)

      // VOCAB-05: a word that is not due yet cannot be reviewed. Because the
      // due date is stored at local midnight, a word due today still passes.
      if (word.nextReviewDate && new Date(word.nextReviewDate) > now) {
        throw new ErrorResponse('This word is not due for review yet', 409)
      }

      const beforeReviewCount = word.reviewCount
      const beforeMastery = word.masteryLevel
      const beforeInterval = word.reviewInterval
      const next = calculateSM2(
        {
          easeFactor: word.easeFactor,
          reviewInterval: word.reviewInterval,
          reviewCount: word.reviewCount,
        },
        r,
        { now, timezone: zone, algorithm: 'sm2' },
      )
      Object.assign(word, next)

      // The XP intent is derived from the same review that changed the word, so
      // the shared SRS engine (and the streak/XP ledgers) stay in agreement.
      const quality = sm2Quality(r)
      word.pendingXpReview =
        quality >= 3 && word.reviewCount > beforeReviewCount
          ? {
              jobKey: vocabularyReviewJobKey(word._id, word.reviewCount, now),
              quality,
              beforeReviewCount,
              beforeMastery,
              snapshot: {
                reviewCount: word.reviewCount,
                masteryLevel: word.masteryLevel,
                word: word.word,
              },
            }
          : null

      await word.save({ session: tx })

      await ReviewEvent.create(
        [
          {
            student: req.user._id,
            vocabulary: word._id,
            rating: r,
            intervalBefore: beforeInterval,
            intervalAfter: next.reviewInterval,
            repetition: next.reviewCount,
            easeFactor: next.easeFactor,
            reviewedAt: now,
            timezone: zone,
            requestId,
            source: 'self_rating',
          },
        ],
        { session: tx },
      )

      return word.toObject()
    },
  )

  const word = out.result
  let xp = { xpEarned: 0 }
  if (!out.replayed && word?.pendingXpReview) {
    try {
      xp = await awardVocabularyReviewXp({
        studentId: req.user._id,
        word,
        quality: word.pendingXpReview.quality,
        beforeReviewCount: word.pendingXpReview.beforeReviewCount,
        beforeMastery: word.pendingXpReview.beforeMastery,
      })
    } catch (err) {
      // The durable source intent remains on the vocabulary document for retry.
      console.error('Vocabulary XP award failed:', err.message)
    }
  }
  if (word) delete word.pendingXpReview
  // A review must not visually demote a word that evidence already proves
  // mastered; the response uses the same effective level as the library.
  const effectiveWord = word
    ? withEffectiveMastery(word, await getMasteredWords(req.user._id))
    : word

  res.status(200).json({
    success: true,
    replayed: out.replayed,
    data: {
      word: effectiveWord,
      nextReviewDate: word?.nextReviewDate,
      reviewInterval: word?.reviewInterval,
      easeFactor: Number(Number(word?.easeFactor || 0).toFixed(2)),
      reviewCount: word?.reviewCount,
    },
    xpEarned: xp.xpEarned || 0,
    totalXp: xp.totalXp,
    level: xp.level,
    levelName: xp.levelName,
    nextLevelXp: xp.nextLevelXp,
    progressPercent: xp.progressPercent,
    levelUp: xp.levelUp || null,
    newBadges: xp.newBadges || [],
    newRewards: xp.newRewards || [],
  })
})

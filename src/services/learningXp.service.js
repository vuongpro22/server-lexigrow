import mongoose from 'mongoose'
import { randomUUID } from 'node:crypto'
import Essay from '../models/Essay.js'
import EssayRevision from '../models/EssayRevision.js'
import Vocabulary from '../models/Vocabulary.js'
import WordUsageEvidence from '../models/WordUsageEvidence.js'
import XpAwardOutbox from '../models/XpAwardOutbox.js'
import { XP_RULES } from '../constants/gamification.js'
import { dayKey } from '../utils/learning.js'
import {
  awardXpBatchWithDailyCap,
  reconcileGamification,
} from './gamification.service.js'
import { verifyTargetWordEvidence } from './ai.service.js'

const TIMEZONE = 'Asia/Ho_Chi_Minh'
let outboxIndexesPromise

async function ensureOutboxIndexes() {
  if (!outboxIndexesPromise) {
    outboxIndexesPromise = XpAwardOutbox.createIndexes().catch((err) => {
      outboxIndexesPromise = null
      throw err
    })
  }
  return outboxIndexesPromise
}

const OUTBOX_LEASE_MS = 60_000
const OUTBOX_RETRY_BASE_MS = 1_000
const OUTBOX_RETRY_MAX_MS = 15 * 60_000
const OUTBOX_BATCH_LIMIT = 25

async function getOutboxResult(job) {
  const state = await reconcileGamification(job.student)
  const result = job.result || {}
  return {
    ...state,
    ...result,
    xpEarned: result.xpEarned || 0,
    batchXpEarned: result.batchXpEarned || job.batches.map(() => 0),
    batchAwardedItems: result.batchAwardedItems || job.batches.map(() => []),
    pending: false,
  }
}

async function processOutboxJob(job) {
  if (job.status === 'completed') return getOutboxResult(job)
  const workerId = randomUUID()
  const now = new Date()
  const claimed = await XpAwardOutbox.findOneAndUpdate(
    {
      _id: job._id,
      $or: [
        { status: 'pending', nextAttemptAt: { $lte: now } },
        { status: 'processing', processingUntil: { $lte: now } },
      ],
    },
    {
      $set: { status: 'processing', workerId, processingUntil: new Date(now.getTime() + OUTBOX_LEASE_MS), lastError: '' },
      $inc: { attempts: 1 },
    },
    { returnDocument: 'after' },
  )
  if (!claimed) return { claimed: false, pending: true }

  try {
    const batchXpEarned = []
    const batchAwardedItems = []
    for (const batch of claimed.batches) {
      const result = await awardXpBatchWithDailyCap(
        claimed.student,
        batch.sourceType,
        batch.items,
        batch.cap,
        batch.baseMeta || {},
      )
      batchXpEarned.push(result.xpEarned)
      batchAwardedItems.push(result.awardedItems)
    }

    const state = await reconcileGamification(claimed.student)
    const savedResult = {
      xpEarned: batchXpEarned.reduce((sum, amount) => sum + amount, 0),
      batchXpEarned,
      batchAwardedItems,
      level: state.level,
      levelName: state.levelName,
      levelUp: state.levelUp,
      newRewards: state.newRewards,
      newBadges: state.newBadges,
      totalXp: state.totalXp,
      nextLevelXp: state.nextLevelXp,
      progressPercent: state.progressPercent,
    }
    await XpAwardOutbox.updateOne(
      { _id: claimed._id, status: 'processing', workerId },
      { $set: { status: 'completed', result: savedResult, completedAt: new Date(), processingUntil: null, lastError: '' } },
    )
    return { ...state, ...savedResult, pending: false }
  } catch (err) {
    const attempt = Math.max(1, Number(claimed.attempts) || 1)
    const delay = Math.min(OUTBOX_RETRY_MAX_MS, OUTBOX_RETRY_BASE_MS * (2 ** Math.min(attempt - 1, 10)))
    await XpAwardOutbox.updateOne(
      { _id: claimed._id, status: 'processing', workerId },
      {
        $set: {
          status: 'pending',
          processingUntil: null,
          nextAttemptAt: new Date(Date.now() + delay),
          lastError: String(err?.message || err).slice(0, 1000),
        },
      },
    )
    throw err
  }
}

async function enqueueAndProcessXp({ studentId, jobKey, batches }) {
  await ensureOutboxIndexes()
  let job
  try {
    job = await XpAwardOutbox.findOneAndUpdate(
      { student: studentId, jobKey },
      { $setOnInsert: { student: studentId, jobKey, batches, status: 'pending', nextAttemptAt: new Date() } },
      { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
    )
  } catch (err) {
    if (err?.code !== 11000) throw err
    job = await XpAwardOutbox.findOne({ student: studentId, jobKey })
  }

  if (!job) throw new Error('Unable to load XP outbox job')

  try {
    const result = await processOutboxJob(job)
    if (result.claimed === false) {
      const latest = await XpAwardOutbox.findById(job._id).lean()
      if (latest?.status === 'completed') return getOutboxResult(latest)
      return { xpEarned: 0, batchXpEarned: job.batches.map(() => 0), batchAwardedItems: job.batches.map(() => []), pending: true, retryable: true }
    }
    return result
  } catch {
    const latest = await XpAwardOutbox.findById(job._id).lean()
    if (latest?.status === 'completed') return getOutboxResult(latest)

    if (latest?.status === 'processing' && latest.processingUntil > new Date()) {
      return { xpEarned: 0, batchXpEarned: job.batches.map(() => 0), batchAwardedItems: job.batches.map(() => []), pending: true, retryable: true }
    }

    return {
      xpEarned: 0,
      batchXpEarned: job.batches.map(() => 0),
      batchAwardedItems: job.batches.map(() => []),
      pending: true,
      retryable: true,
    }
  }
}

/** Retry pending XP jobs without letting a failing oldest job starve newer work. */
async function retryPendingVocabularyReviewIntents({ studentId, limit = OUTBOX_BATCH_LIMIT } = {}) {
  const words = await Vocabulary.find({ pendingXpReview: { $ne: null }, ...(studentId ? { student: studentId } : {}) })
    .sort({ updatedAt: 1 })
    .select('student word reviewCount masteryLevel pendingXpReview')
    .limit(Math.max(1, Math.min(100, Number(limit) || OUTBOX_BATCH_LIMIT)))
    .lean()
  let completed = 0
  let failed = 0
  for (const word of words) {
    try {
      const intent = word.pendingXpReview
      const result = await enqueueAndProcessXp({
        studentId: word.student,
        jobKey: intent.jobKey,
        batches: [{
          sourceType: 'vocabulary',
          cap: XP_RULES.vocabDailyCap,
          baseMeta: { word: intent.snapshot?.word || word.word },
          items: [
            ...(intent.beforeReviewCount === 0 ? [{
              sourceId: `vocab_first:${intent.snapshot?.word || word.word}`,
              amount: XP_RULES.vocabFirstReview,
              meta: { word: intent.snapshot?.word || word.word, kind: 'first_review' },
            }] : []),
            {
              sourceId: `vocab_day:${intent.snapshot?.word || word.word}:${dayKey(new Date(), TIMEZONE)}`,
              amount: XP_RULES.vocabDailyReview,
              meta: { word: intent.snapshot?.word || word.word, kind: 'daily_review' },
            },
            ...(intent.beforeMastery !== 'mastered' && intent.snapshot?.masteryLevel === 'mastered' ? [{
              sourceId: `vocab_mastered:${intent.snapshot.word}`,
              amount: XP_RULES.vocabMastered,
              meta: { word: intent.snapshot.word, kind: 'mastered' },
            }] : []),
          ],
        }],
      })
      if (result.pending) {
        failed += 1
        continue
      }
      await Vocabulary.updateOne(
        { _id: word._id, 'pendingXpReview.jobKey': intent.jobKey },
        { $set: { pendingXpReview: null } },
      )
      completed += 1
    } catch {
      failed += 1
    }
  }
  return { checked: words.length, completed, failed }
}

export async function retryPendingXpAwards({ studentId, limit = OUTBOX_BATCH_LIMIT } = {}) {
  await ensureOutboxIndexes()
  const now = new Date()
  const filter = {
    $or: [
      { status: 'pending', nextAttemptAt: { $lte: now } },
      { status: 'processing', processingUntil: { $lte: now } },
    ],
  }
  const vocabularyIntentResults = await retryPendingVocabularyReviewIntents({ studentId, limit })
  if (studentId) filter.student = studentId

  const jobs = await XpAwardOutbox.find(filter)
    .sort({ nextAttemptAt: 1, createdAt: 1 })
    .limit(Math.max(1, Math.min(100, Number(limit) || OUTBOX_BATCH_LIMIT)))
    .lean()

  let completed = 0
  let failed = 0
  for (const job of jobs) {
    try {
      const result = await processOutboxJob(job)
      if (result.claimed === false) continue
      completed += 1
    } catch {
      failed += 1
    }
  }
  return {
    checked: jobs.length + vocabularyIntentResults.checked,
    completed: completed + vocabularyIntentResults.completed,
    failed: failed + vocabularyIntentResults.failed,
  }
}

// The outbox is durable across restarts; this bounded poll resumes pending work.
let outboxWorker

export function startXpOutboxWorker() {
  if (process.env.NODE_ENV === 'test' || outboxWorker) return outboxWorker

  const poll = () => {
    if (mongoose.connection.readyState !== 1) return
    retryPendingXpAwards().catch((err) => {
      console.error('[XP outbox] retry poll failed:', err.message)
    })
  }

  outboxWorker = setInterval(poll, 30_000)
  outboxWorker.unref?.()
  poll()
  return outboxWorker
}

/**
 * Vocabulary XP is tied to a successful SRS review, mastery, and verified use.
 * Saving a word alone never calls this service.
 */
export function vocabularyReviewJobKey(wordId, reviewCount, when = new Date()) {
  // The reviewed day is part of the key: after "Again" the review count resets,
  // so without the date the next successful review would collide with an older
  // XP job for the same word and be skipped.
  return `vocabulary_review:${wordId}:${dayKey(when, TIMEZONE)}:${reviewCount}`
}

export async function awardVocabularyReviewXp({
  studentId,
  word,
  quality,
  beforeReviewCount,
  beforeMastery,
}) {
  if (quality < 3 || word.reviewCount <= beforeReviewCount) {
    return { xpEarned: 0 }
  }

  const wordKey = word.word || String(word._id)
  const items = [
    {
      sourceId: `vocab_day:${wordKey}:${dayKey(new Date(), TIMEZONE)}`,
      amount: XP_RULES.vocabDailyReview,
      meta: { word: wordKey, kind: 'daily_review' },
    },
  ]
  if (beforeReviewCount === 0) {
    items.unshift({
      sourceId: `vocab_first:${wordKey}`,
      amount: XP_RULES.vocabFirstReview,
      meta: { word: wordKey, kind: 'first_review' },
    })
  }
  if (beforeMastery !== 'mastered' && word.masteryLevel === 'mastered') {
    items.push({
      sourceId: `vocab_mastered:${wordKey}`,
      amount: XP_RULES.vocabMastered,
      meta: { word: wordKey, kind: 'mastered' },
    })
  }

  // Use the key stored with the review intent. Recomputing "today" here means
  // a review that finished just after midnight would look up a different job
  // and leave the intent pending forever.
  const jobKey = word.pendingXpReview?.jobKey
    || vocabularyReviewJobKey(word._id || wordKey, word.reviewCount)
  const result = await enqueueAndProcessXp({
    studentId,
    jobKey,
    batches: [{
      sourceType: 'vocabulary',
      cap: XP_RULES.vocabDailyCap,
      baseMeta: { word: wordKey },
      items,
    }],
  })
  if (!result.pending && word.pendingXpReview?.jobKey === jobKey) {
    await Vocabulary.updateOne(
      { _id: word._id, 'pendingXpReview.jobKey': word.pendingXpReview.jobKey },
      { $set: { pendingXpReview: null } },
    )
  }
  return {
    ...result,
    awardedItems: result.batchAwardedItems?.[0] || [],
  }
}

/**
 * Called only after a successful AI analysis. Drafts and flagged plagiarism
 * never reach this service.
 */
export async function awardEssayXp({ studentId, essayId, revisionId, analysis }) {
  if (!studentId || !analysis) return { xpEarned: 0 }
  if (analysis.isFallback) return { xpEarned: 0, skipped: 'fallback_analysis' }
  if (analysis.plagiarismDetails?.status === 'unavailable') {
    return { xpEarned: 0, skipped: 'plagiarism_unavailable' }
  }
  if (
    analysis.plagiarismDetails?.isPlagiarized ||
    analysis.learningPatterns?.plagiarismDetected
  ) {
    return { xpEarned: 0, skipped: 'plagiarism' }
  }

  const essay = await Essay.findOne({ _id: essayId, student: studentId })
    .select('wordCount content')
    .lean()
  if (!essay) return { xpEarned: 0 }

  const revision = revisionId
    ? await EssayRevision.findById(revisionId)
        .select('revisionNumber wordCount content targetWordResults comparison assisted')
        .lean()
    : null

  const essayContent = revision?.content || essay.content || ''
  const wordCount = revision?.wordCount || essay.wordCount || 0
  const rawEvaluations = Array.isArray(analysis.targetWordEvaluations) && analysis.targetWordEvaluations.length > 0
    ? analysis.targetWordEvaluations
    : (revision?.targetWordResults || [])
  const evaluations = verifyTargetWordEvidence(rawEvaluations, essayContent)
  const correctTargets = evaluations.filter(
    (item) => item.status === 'correct' && item.quoteVerified,
  ).length
  const targetXp = Math.min(
    XP_RULES.essayTargetWordMax,
    correctTargets * XP_RULES.essayTargetWord,
  )

  const essayItems = []
  if (wordCount >= XP_RULES.essayMinWords) {
    essayItems.push({
      sourceId: `essay_base:${essayId}`,
      amount: XP_RULES.essayBase,
      meta: { essayId, kind: 'analyzed' },
    })
    if (targetXp > 0) {
      essayItems.push({
        sourceId: `essay_targets:${essayId}`,
        amount: targetXp,
        meta: { essayId, correctTargets, kind: 'target_words' },
      })
    }
    if (wordCount >= XP_RULES.essayLengthThreshold) {
      essayItems.push({
        sourceId: `essay_length:${essayId}`,
        amount: XP_RULES.essayLengthBonus,
        meta: { essayId, wordCount, kind: 'length_bonus' },
      })
    }
  }

  if (
    revision &&
    revision.revisionNumber >= 2 &&
    revision.revisionNumber <= 3 &&
    revision.comparison?.resolvedWords?.length > 0
  ) {
    essayItems.push({
      sourceId: `essay_revision:${revisionId}:improvement`,
      amount: XP_RULES.essayRevisionBonus,
      meta: { essayId, revisionId, kind: 'revision_improvement' },
    })
  }

  const usageItems = []
  if (revisionId) {
    const evidence = await WordUsageEvidence.find({
      revisionId,
      isVerifiedCorrect: true,
      assisted: false,
    })
      .select('word')
      .lean()
    const words = [...new Set(evidence.map((row) => row.word).filter(Boolean))]
    usageItems.push(...words.map((word) => ({
      sourceId: `vocab_use:${word}:${essayId}`,
      amount: XP_RULES.vocabUsage,
      meta: { word, essayId, kind: 'verified_usage' },
    })))
  }

  const batches = [
    { sourceType: 'essay', cap: XP_RULES.essayDailyCap, baseMeta: { essayId }, items: essayItems },
    { sourceType: 'vocabulary', cap: XP_RULES.vocabDailyCap, baseMeta: { essayId }, items: usageItems },
  ]
  const result = await enqueueAndProcessXp({
    studentId,
    jobKey: `essay_analysis:${essayId}:${revisionId || 'base'}`,
    batches,
  })
  const state = { ...result }
  const batchXpEarned = state.batchXpEarned || []
  delete state.batchXpEarned
  delete state.batchAwardedItems
  return {
    ...state,
    essayXp: batchXpEarned[0] || 0,
    wordUsageXp: batchXpEarned[1] || 0,
  }
}

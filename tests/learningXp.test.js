import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { MongoMemoryServer } from 'mongodb-memory-server'
import mongoose from 'mongoose'
import User from '../src/models/User.js'
import Essay from '../src/models/Essay.js'
import EssayRevision from '../src/models/EssayRevision.js'
import GamificationProfile from '../src/models/GamificationProfile.js'
import LevelRule from '../src/models/LevelRule.js'
import RewardGrant from '../src/models/RewardGrant.js'
import Vocabulary from '../src/models/Vocabulary.js'
import WordUsageEvidence from '../src/models/WordUsageEvidence.js'
import XpEvent from '../src/models/XpEvent.js'
import XpQuota from '../src/models/XpQuota.js'
import XpAwardOutbox from '../src/models/XpAwardOutbox.js'
import { dayKey } from '../src/utils/learning.js'
import {
  awardEssayXp,
  awardVocabularyReviewXp,
  retryPendingXpAwards,
  vocabularyReviewJobKey,
} from '../src/services/learningXp.service.js'
import { awardXpBatchWithDailyCap, ensureDefaultLevelRules } from '../src/services/gamification.service.js'

let mongo, student

beforeAll(async () => {
  mongo = await MongoMemoryServer.create()
  await mongoose.connect(mongo.getUri())
  await Promise.all([
    Essay.init(),
    EssayRevision.init(),
    GamificationProfile.init(),
    LevelRule.init(),
    RewardGrant.init(),
    Vocabulary.init(),
    WordUsageEvidence.init(),
    XpEvent.init(),
    XpQuota.init(),
    XpAwardOutbox.init(),
  ])
}, 180_000)

afterAll(async () => {
  await mongoose.disconnect()
  await mongo?.stop()
})

beforeEach(async () => {
  await Promise.all([
    Essay.deleteMany({}),
    EssayRevision.deleteMany({}),
    GamificationProfile.deleteMany({}),
    LevelRule.deleteMany({}),
    RewardGrant.deleteMany({}),
    Vocabulary.deleteMany({}),
    WordUsageEvidence.deleteMany({}),
    XpEvent.deleteMany({}),
    XpQuota.deleteMany({}),
    XpAwardOutbox.deleteMany({}),
  ])
  await ensureDefaultLevelRules()
  student = await User.create({
    name: 'Learning XP Student',
    email: `learning-xp-${Date.now()}@example.test`,
    password: 'test1234',
    role: 'student',
  })
})

describe('learning XP rules', () => {
  it('does not award vocabulary XP just for saving a word', async () => {
    await Vocabulary.create({
      student: student._id,
      word: 'diligent',
      definition: 'Careful and persistent',
      masteryLevel: 'new',
    })
    expect(await XpEvent.countDocuments({ sourceType: 'vocabulary' })).toBe(0)
  })

  it('awards first review, daily review and mastery only once', async () => {
    const word = await Vocabulary.create({
      student: student._id,
      word: 'diligent',
      definition: 'Careful and persistent',
      masteryLevel: 'learning',
      reviewCount: 1,
    })

    const first = await awardVocabularyReviewXp({
      studentId: student._id,
      word,
      quality: 4,
      beforeReviewCount: 0,
      beforeMastery: 'new',
    })
    expect(first.xpEarned).toBe(3) // +2 first review, +1 daily review
    expect(await XpEvent.countDocuments({ sourceType: 'vocabulary' })).toBe(2)

    const sameDay = await awardVocabularyReviewXp({
      studentId: student._id,
      word: { ...word.toObject(), reviewCount: 2, masteryLevel: 'learning' },
      quality: 4,
      beforeReviewCount: 1,
      beforeMastery: 'learning',
    })
    expect(sameDay.xpEarned).toBe(0)

    const mastered = await awardVocabularyReviewXp({
      studentId: student._id,
      word: { ...word.toObject(), reviewCount: 3, masteryLevel: 'mastered' },
      quality: 4,
      beforeReviewCount: 2,
      beforeMastery: 'learning',
    })
    expect(mastered.xpEarned).toBe(10) // only mastery is new
    expect(await XpEvent.countDocuments({ sourceType: 'vocabulary' })).toBe(3)

    const repeatMastery = await awardVocabularyReviewXp({
      studentId: student._id,
      word: { ...word.toObject(), reviewCount: 4, masteryLevel: 'mastered' },
      quality: 4,
      beforeReviewCount: 3,
      beforeMastery: 'mastered',
    })
    expect(repeatMastery.xpEarned).toBe(0)
  })

  it('limits simultaneous distinct events to the daily cap', async () => {
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        awardXpBatchWithDailyCap(
          student._id,
          'essay',
          [{ sourceId: 'parallel-' + index, amount: 10 }],
          50,
        ),
      ),
    )

    const [quota] = await XpQuota.find({ student: student._id, sourceType: 'essay' })
    const total = await XpEvent.aggregate([
      { $match: { student: student._id, sourceType: 'essay' } },
      { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } },
    ])
    expect(quota.used).toBe(50)
    expect(total[0].total).toBe(50)
    expect(total[0].count).toBe(5)
  })

  it('keeps empty quota reservations unique per day while sources remain unique across days', async () => {
    await XpQuota.create({ student: student._id, sourceType: 'vocabulary', day: '2026-11-01', used: 0, reservations: [] })
    await XpQuota.create({ student: student._id, sourceType: 'vocabulary', day: '2026-11-02', used: 0, reservations: [] })
    await XpQuota.create({ student: student._id, sourceType: 'vocabulary', day: '2026-11-03', used: 1, reservations: [{ sourceId: 'source-a', amount: 1 }] })
    await expect(XpQuota.create({ student: student._id, sourceType: 'vocabulary', day: '2026-11-04', used: 1, reservations: [{ sourceId: 'source-a', amount: 1 }] })).rejects.toMatchObject({ code: 11000 })
  })

  it('keeps real XP event timestamps while retaining quota day', async () => {
    const before = Date.now()
    await awardXpBatchWithDailyCap(student._id, 'essay', [{ sourceId: 'live-time', amount: 2 }], 50)
    const event = await XpEvent.findOne({ sourceId: 'live-time' })
    expect(event.createdAt.getTime()).toBeGreaterThanOrEqual(before)
    expect(event.quotaDay).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('replays the stored XP total for a completed outbox job', async () => {
    const word = await Vocabulary.create({ student: student._id, word: 'replayable', definition: 'Can replay', masteryLevel: 'learning', reviewCount: 1 })
    const first = await awardVocabularyReviewXp({ studentId: student._id, word, quality: 4, beforeReviewCount: 0, beforeMastery: 'new' })
    const replay = await awardVocabularyReviewXp({ studentId: student._id, word, quality: 4, beforeReviewCount: 0, beforeMastery: 'new' })
    expect(first.xpEarned).toBe(3)
    expect(replay.xpEarned).toBe(first.xpEarned)
  })

  it('does not let a failed oldest job block a newer due job', async () => {
    const word = await Vocabulary.create({ student: student._id, word: 'fresh', definition: 'new', masteryLevel: 'learning', reviewCount: 1 })
    await XpAwardOutbox.create({ student: student._id, jobKey: 'old-failed', status: 'pending', attempts: 2, nextAttemptAt: new Date(Date.now() + 60_000), batches: [{ sourceType: 'essay', cap: 50, items: [{ sourceId: 'old-source', amount: 1 }] }] })
    await XpAwardOutbox.create({ student: student._id, jobKey: 'new-due', status: 'pending', nextAttemptAt: new Date(0), batches: [{ sourceType: 'vocabulary', cap: 30, items: [{ sourceId: 'new-source', amount: 1 }] }] })
    await expect(retryPendingXpAwards({ studentId: student._id })).resolves.toMatchObject({ checked: 1, completed: 1, failed: 0 })
    expect(await XpEvent.exists({ sourceId: 'new-source' })).toBeTruthy()
    expect(await XpEvent.exists({ sourceId: 'old-source' })).toBeFalsy()
  })

  it('stores actual award time and reuses the reservation without consuming cap twice', async () => {
    const create = vi.spyOn(XpEvent, 'create').mockRejectedValueOnce(new Error('transient insert failure'))
    const before = Date.now()
    await expect(awardXpBatchWithDailyCap(student._id, 'essay', [{ sourceId: 'failed-source', amount: 3 }], 50)).rejects.toThrow('transient insert failure')
    create.mockRestore()
    const quota = await XpQuota.findOne({ student: student._id, sourceType: 'essay' })
    expect(quota.used).toBe(0)
    expect(quota.reservations).toHaveLength(0)
    await awardXpBatchWithDailyCap(student._id, 'essay', [{ sourceId: 'succeeded-source', amount: 3 }], 50)
    const event = await XpEvent.findOne({ sourceId: 'succeeded-source' })
    expect(event.createdAt.getTime()).toBeGreaterThanOrEqual(before)
  })

  it('reclaims expired outbox processing leases', async () => {
    const job = await XpAwardOutbox.create({ student: student._id, jobKey: 'abandoned-processing', status: 'processing', processingUntil: new Date(0), batches: [{ sourceType: 'essay', cap: 50, items: [{ sourceId: 'recoverable', amount: 2 }] }] })
    await expect(retryPendingXpAwards({ studentId: student._id })).resolves.toMatchObject({ checked: 1, completed: 1, failed: 0 })
    expect((await XpAwardOutbox.findById(job._id)).status).toBe('completed')
    expect(await XpEvent.exists({ sourceId: 'recoverable' })).toBeTruthy()
  })

  it('only reports a concurrent outbox job as owned by one processor', async () => {
    const job = await XpAwardOutbox.create({ student: student._id, jobKey: 'concurrent-processing', status: 'pending', nextAttemptAt: new Date(0), batches: [{ sourceType: 'essay', cap: 50, items: [{ sourceId: 'concurrent-source', amount: 4 }] }] })
    const [first, second] = await Promise.all([
      XpAwardOutbox.findById(job._id).lean().then(retryPendingXpAwards.bind(null, { studentId: student._id })),
      retryPendingXpAwards({ studentId: student._id }),
    ])
    expect(first.checked + second.checked).toBeGreaterThanOrEqual(1)
    expect(await XpEvent.countDocuments({ sourceId: 'concurrent-source' })).toBe(1)
  })

  it('preserves partial progress when the same event was concurrently inserted', async () => {
    const sourceId = 'race-event-source'
    await awardXpBatchWithDailyCap(student._id, 'essay', [{ sourceId, amount: 2 }], 50)
    const replay = await awardXpBatchWithDailyCap(student._id, 'essay', [{ sourceId, amount: 2 }], 50)
    expect(replay.xpEarned).toBe(0)
    expect(await XpEvent.countDocuments({ student: student._id, sourceType: 'essay', sourceId })).toBe(1)
  })


  it('recovers a persisted SRS intent after a request dies', async () => {
    const word = await Vocabulary.create({
      student: student._id,
      word: 'restartable',
      definition: 'Can recover after restart',
      masteryLevel: 'learning',
      reviewCount: 1,
      pendingXpReview: {
        jobKey: 'vocabulary_review_intent:restartable:1',
        quality: 4,
        beforeReviewCount: 0,
        beforeMastery: 'new',
        snapshot: { reviewCount: 1, masteryLevel: 'learning', word: 'restartable' },
      },
    })
    await expect(retryPendingXpAwards({ studentId: student._id })).resolves.toMatchObject({ checked: 1, completed: 1, failed: 0 })
    expect(await XpEvent.countDocuments({ student: student._id, sourceType: 'vocabulary' })).toBe(2)
    expect((await Vocabulary.findById(word._id)).pendingXpReview).toBeNull()
  })

  it('retries learning XP from its durable outbox after a transient ledger failure', async () => {
    const word = await Vocabulary.create({ student: student._id, word: 'resilient', definition: 'Able to recover', masteryLevel: 'learning', reviewCount: 1 })
    const create = vi.spyOn(XpEvent, 'create').mockRejectedValueOnce(new Error('temporary ledger failure'))
    const pending = await awardVocabularyReviewXp({ studentId: student._id, word, quality: 4, beforeReviewCount: 0, beforeMastery: 'new' })
    expect(pending).toMatchObject({ xpEarned: 0, pending: true, retryable: true })
    expect(await XpEvent.countDocuments({ student: student._id })).toBe(0)
    await XpAwardOutbox.updateOne({ student: student._id, jobKey: vocabularyReviewJobKey(word._id, 1) }, { $set: { nextAttemptAt: new Date(0) } })
    create.mockRestore()
    await expect(retryPendingXpAwards({ studentId: student._id })).resolves.toMatchObject({ checked: 1, completed: 1, failed: 0 })
    expect(await XpEvent.countDocuments({ student: student._id, sourceType: 'vocabulary' })).toBe(2)
    expect((await Vocabulary.findById(word._id)).pendingXpReview).toBeNull()
  })

  it('awards essay base, target-word bonus and length bonus once', async () => {
    const essay = await Essay.create({
      student: student._id,
      title: 'My essay',
      content: 'A diligent learner reads every day. Her explanation was lucid and clear.',
      wordCount: 130,
      status: 'reviewed',
    })
    const revision = await EssayRevision.create({
      originalEssay: essay._id,
      student: student._id,
      session: new mongoose.Types.ObjectId(),
      revisionNumber: 1,
      content: 'A diligent learner reads every day. Her explanation was lucid and clear.',
      contentHash: 'hash-1',
      wordCount: 130,
      targetWords: ['diligent', 'lucid'],
      analysisStatus: 'succeeded',
      comparison: {},
    })
    const analysis = {
      plagiarismDetails: { isPlagiarized: false },
      learningPatterns: { plagiarismDetected: false },
      targetWordEvaluations: [
        { word: 'diligent', status: 'correct', found: true, contextQuote: 'A diligent learner reads every day.' },
        { word: 'lucid', status: 'correct', found: true, contextQuote: 'Her explanation was lucid and clear.' },
      ],
    }

    const first = await awardEssayXp({
      studentId: student._id,
      essayId: essay._id,
      revisionId: revision._id,
      analysis,
    })
    expect(first.xpEarned).toBe(22) // 15 base + 2 targets + 5 length
    expect(await XpEvent.countDocuments({ sourceType: 'essay' })).toBe(3)

    const repeat = await awardEssayXp({
      studentId: student._id,
      essayId: essay._id,
      revisionId: revision._id,
      analysis,
    })
    expect(repeat.xpEarned).toBe(first.xpEarned)
  })

  it('adds a small improvement bonus on revision 2-3 only', async () => {
    const essay = await Essay.create({
      student: student._id,
      title: 'Revision essay',
      content: 'A diligent learner reads every day.',
      wordCount: 130,
      status: 'reviewed',
    })
    const revision1 = await EssayRevision.create({
      originalEssay: essay._id,
      student: student._id,
      session: new mongoose.Types.ObjectId(),
      revisionNumber: 1,
      content: 'A diligent learner reads every day.',
      contentHash: 'hash-1',
      wordCount: 130,
      targetWords: ['diligent'],
      analysisStatus: 'succeeded',
      comparison: {},
    })
    const analysis = {
      plagiarismDetails: { isPlagiarized: false },
      learningPatterns: { plagiarismDetected: false },
      targetWordEvaluations: [{ word: 'diligent', status: 'correct', found: true }],
    }
    await awardEssayXp({
      studentId: student._id,
      essayId: essay._id,
      revisionId: revision1._id,
      analysis,
    })

    const revision2 = await EssayRevision.create({
      originalEssay: essay._id,
      student: student._id,
      session: new mongoose.Types.ObjectId(),
      revisionNumber: 2,
      content: 'content 2',
      contentHash: 'hash-2',
      wordCount: 130,
      targetWords: ['diligent'],
      analysisStatus: 'succeeded',
      comparison: { resolvedWords: ['diligent'] },
    })
    const improved = await awardEssayXp({
      studentId: student._id,
      essayId: essay._id,
      revisionId: revision2._id,
      analysis,
    })
    expect(improved.xpEarned).toBe(5)
  })

  it('does not award essay XP for fallback analysis', async () => {
    const essay = await Essay.create({
      student: student._id,
      title: 'Fallback essay',
      content: 'A sufficiently long essay that must not earn analysis XP when grading fell back.',
      wordCount: 130,
      status: 'reviewed',
    })
    const result = await awardEssayXp({
      studentId: student._id,
      essayId: essay._id,
      analysis: { isFallback: true, overallScore: null, targetWordEvaluations: [] },
    })
    expect(result).toEqual({ xpEarned: 0, skipped: 'fallback_analysis' })
    expect(await XpEvent.countDocuments({ sourceType: 'essay' })).toBe(0)
  })

  it('does not award essay XP for plagiarism', async () => {
    const essay = await Essay.create({
      student: student._id,
      title: 'Flagged essay',
      content: 'content',
      wordCount: 130,
      status: 'reviewed',
    })
    const result = await awardEssayXp({
      studentId: student._id,
      essayId: essay._id,
      analysis: {
        plagiarismDetails: { isPlagiarized: true },
        learningPatterns: { plagiarismDetected: true },
        targetWordEvaluations: [],
      },
    })
    expect(result.xpEarned).toBe(0)
  })

  it('does not award essay XP when plagiarism verification is unavailable', async () => {
    const essay = await Essay.create({
      student: student._id,
      title: 'Unverified essay',
      content: 'A sufficiently long essay that must wait until plagiarism check succeeds.',
      wordCount: 130,
      status: 'reviewed',
    })
    const result = await awardEssayXp({
      studentId: student._id,
      essayId: essay._id,
      analysis: {
        isFallback: false,
        plagiarismDetails: { isPlagiarized: false, status: 'unavailable' },
        learningPatterns: { plagiarismDetected: false },
        targetWordEvaluations: [],
      },
    })
    expect(result).toEqual({ xpEarned: 0, skipped: 'plagiarism_unavailable' })
    expect(await XpEvent.countDocuments({ sourceType: 'essay' })).toBe(0)
  })

  it('awards verified word usage once per word per essay', async () => {
    const essay = await Essay.create({
      student: student._id,
      title: 'Usage essay',
      content: 'A diligent learner reads every day. Her explanation was lucid and clear.',
      wordCount: 130,
      status: 'reviewed',
    })
    const revision = await EssayRevision.create({
      originalEssay: essay._id,
      student: student._id,
      session: new mongoose.Types.ObjectId(),
      revisionNumber: 1,
      content: 'A diligent learner reads every day. Her explanation was lucid and clear.',
      contentHash: 'hash-usage',
      wordCount: 130,
      targetWords: ['diligent', 'lucid'],
      analysisStatus: 'succeeded',
      comparison: {},
    })
    await WordUsageEvidence.create([
      {
        student: student._id,
        word: 'diligent',
        contextSentence: 'She is diligent.',
        essayId: essay._id,
        revisionId: revision._id,
        isVerifiedCorrect: true,
        assisted: false,
        localDay: '2026-11-04',
      },
      {
        student: student._id,
        word: 'lucid',
        contextSentence: 'Her writing is lucid.',
        essayId: essay._id,
        revisionId: revision._id,
        isVerifiedCorrect: true,
        assisted: false,
        localDay: '2026-11-04',
      },
    ])
    const analysis = {
      plagiarismDetails: { isPlagiarized: false },
      learningPatterns: { plagiarismDetected: false },
      targetWordEvaluations: [
        { word: 'diligent', status: 'correct', found: true, contextQuote: 'A diligent learner reads every day.' },
        { word: 'lucid', status: 'correct', found: true, contextQuote: 'Her explanation was lucid and clear.' },
      ],
    }

    const first = await awardEssayXp({
      studentId: student._id,
      essayId: essay._id,
      revisionId: revision._id,
      analysis,
    })
    // 22 essay XP + 2 words x 2 XP usage.
    expect(first.xpEarned).toBe(26)
    const repeat = await awardEssayXp({
      studentId: student._id,
      essayId: essay._id,
      revisionId: revision._id,
      analysis,
    })
    expect(repeat.xpEarned).toBe(first.xpEarned)
  })

  it('falls back to revision targetWordResults when essay targetWordEvaluations is empty', async () => {
    const essay = await Essay.create({
      student: student._id,
      title: 'Revision fallback targets',
      content: 'I kept a steady routine before class.',
      wordCount: 130,
      status: 'reviewed',
    })
    const revision = await EssayRevision.create({
      originalEssay: essay._id,
      student: student._id,
      session: new mongoose.Types.ObjectId(),
      revisionNumber: 1,
      content: 'I kept a steady routine before class.',
      contentHash: 'hash-rev-fallback',
      wordCount: 130,
      targetWords: ['routine'],
      targetWordResults: [
        { word: 'routine', status: 'correct', found: true, matchedText: 'I kept a steady routine before class.' },
      ],
      analysisStatus: 'succeeded',
      comparison: {},
    })

    const awarded = await awardEssayXp({
      studentId: student._id,
      essayId: essay._id,
      revisionId: revision._id,
      analysis: {
        isFallback: false,
        plagiarismDetails: { isPlagiarized: false },
        learningPatterns: { plagiarismDetected: false },
        targetWordEvaluations: [],
      },
    })
    // 15 essayBase + 5 essayLengthBonus (wordCount 130 >= 120) + 1 verified target word from revision fallback
    expect(awarded.xpEarned).toBe(21)
  })

})

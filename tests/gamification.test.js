import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest'
import { MongoMemoryServer } from 'mongodb-memory-server'
import mongoose from 'mongoose'
import User from '../src/models/User.js'
import DailyQuest from '../src/models/DailyQuest.js'
import GameResult from '../src/models/GameResult.js'
import GameSession from '../src/models/GameSession.js'
import GamificationProfile from '../src/models/GamificationProfile.js'
import LevelRule from '../src/models/LevelRule.js'
import RewardGrant from '../src/models/RewardGrant.js'
import XpEvent from '../src/models/XpEvent.js'
import XpQuota from '../src/models/XpQuota.js'
import {
  awardDailyQuestXp,
  awardGameXp,
  awardXp,
  ensureDefaultLevelRules,
  getGamificationSummary,
  levelForXp,
  reconcileGamification,
} from '../src/services/gamification.service.js'
import { finishGameSession, startGameSession } from '../src/services/gameSession.service.js'

let mongo, student

beforeAll(async () => {
  mongo = await MongoMemoryServer.create()
  await mongoose.connect(mongo.getUri())
  await Promise.all([
    GamificationProfile.init(),
    LevelRule.init(),
    RewardGrant.init(),
    XpEvent.init(),
    XpQuota.init(),
    GameSession.init(),
    GameResult.init(),
    DailyQuest.init(),
  ])
}, 180_000)

afterAll(async () => {
  await mongoose.disconnect()
  await mongo?.stop()
})

beforeEach(async () => {
  await Promise.all([
    GamificationProfile.deleteMany({}),
    LevelRule.deleteMany({}),
    RewardGrant.deleteMany({}),
    XpEvent.deleteMany({}),
    XpQuota.deleteMany({}),
    GameSession.deleteMany({}),
    GameResult.deleteMany({}),
    DailyQuest.deleteMany({}),
  ])
  student = await User.create({
    name: 'Gamification Student',
    email: `gamification-${Date.now()}@example.test`,
    password: 'test1234',
    role: 'student',
  })
  await ensureDefaultLevelRules()
})

describe('gamification rules', () => {
  it('maps XP to the correct level', async () => {
    const rules = await LevelRule.find({ isActive: true }).sort({ minXp: 1 }).lean()
    expect(levelForXp(0, rules).level).toBe(1)
    expect(levelForXp(149, rules).level).toBe(1)
    expect(levelForXp(150, rules).level).toBe(2)
    expect(levelForXp(7000, rules).level).toBe(10)
  })

  it('awards XP once per source and levels up with a reward', async () => {
    for (let index = 0; index < 8; index += 1) {
      const quest = await DailyQuest.create({
        student: student._id,
        day: `2026-01-${String(index + 1).padStart(2, '0')}`,
        words: [],
        reward: 1,
        completedAt: new Date(),
      })
      const initial = await awardXp(student._id, 'daily_quest', String(quest._id), 20, { day: quest.day })
      // Retry must not create a second event, and returns the stored amount.
      const replay = await awardXp(student._id, 'daily_quest', String(quest._id), 20, { day: quest.day })
      expect(initial).toEqual({ awarded: true, amount: 20 })
      expect(replay).toEqual({ awarded: false, amount: 20 })
    }

    const state = await reconcileGamification(student._id)
    expect(state.totalXp).toBe(160)
    expect(state.level).toBe(2)
    expect(state.newBadges).toContain('first_quest')
    expect(state.newBadges).toContain('quest_explorer')
    expect(state.newRewards.some((reward) => reward.type === 'firefly')).toBe(true)

    const summary = await getGamificationSummary(student._id)
    expect(summary.totalXp).toBe(160)
    expect(summary.fireflies).toBe(9) // 8 quests + 1 level reward
    expect(summary.badges.map((badge) => badge.key)).toContain('first_quest')
  })

  it('keeps backfill XP out of today/week activity totals', async () => {
    await XpEvent.create({
      student: student._id,
      sourceType: 'backfill',
      sourceId: 'v1',
      amount: 1000,
    })
    const summary = await getGamificationSummary(student._id)
    expect(summary.totalXp).toBe(1000)
    expect(summary.todayXp).toBe(0)
    expect(summary.weekXp).toBe(0)
  })

  it('does not pay a historical quest twice after backfill', async () => {
    const quest = await DailyQuest.create({
      student: student._id,
      day: '2025-01-01',
      words: [],
      reward: 1,
      completedAt: new Date('2025-01-01T00:00:00Z'),
    })
    await XpEvent.create({
      student: student._id,
      sourceType: 'backfill',
      sourceId: 'v1',
      amount: 1000,
    })

    const result = await awardDailyQuestXp(student._id, quest)
    expect(result.xpEarned).toBe(0)
    expect(await XpEvent.countDocuments({ sourceType: 'daily_quest' })).toBe(0)
    expect(result.totalXp).toBe(1000)
  })

  it('stores one game result per session and does not pay XP twice', async () => {
    const session = await startGameSession(student._id, 'hunter', { speedLevel: 'medium' })
    await GameSession.updateOne({ _id: session.sessionId }, { $set: { challenges: [], answers: [] } })
    const body = {
      score: 1500,
      correct: 15,
      total: 15,
      durationMs: 90_000,
      meta: { livesRemaining: 2 },
    }

    const first = await finishGameSession(student._id, 'hunter', session.sessionId, body)
    expect(first.xpEarned).toBe(25)
    expect(first.replayed).toBe(false)
    expect(await GameResult.countDocuments()).toBe(1)
    expect(await XpEvent.countDocuments({ sourceType: 'game' })).toBe(1)

    await GameResult.updateOne({ session: session.sessionId }, { $set: { xpEarned: 0 } })
    const second = await finishGameSession(student._id, 'hunter', session.sessionId, body)
    expect(second.replayed).toBe(true)
    expect(second.xpEarned).toBe(25)
    expect(second.result.xpEarned).toBe(25)
    expect((await GameResult.findOne({ session: session.sessionId })).xpEarned).toBe(25)
    expect(await GameResult.countDocuments()).toBe(1)
    expect(await XpEvent.countDocuments({ sourceType: 'game' })).toBe(1)
  })

  it('keeps concurrent distinct game awards within the daily cap', async () => {
    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        awardGameXp(
          student._id,
          new mongoose.Types.ObjectId(),
          'hunter',
          15,
          15,
          { parallelIndex: index },
        ),
      ),
    )

    const [totals] = await XpEvent.aggregate([
      { $match: { student: student._id, sourceType: 'game' } },
      { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } },
    ])
    expect(totals.total).toBe(50)
    expect(totals.total).toBeLessThanOrEqual(60)
    expect(totals.count).toBe(2)
  })
})

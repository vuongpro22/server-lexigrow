import { beforeAll, afterAll, beforeEach, describe, it, expect, vi } from 'vitest'
import { MongoMemoryServer } from 'mongodb-memory-server'
import mongoose from 'mongoose'
import express from 'express'
import jwt from 'jsonwebtoken'
import request from 'supertest'
vi.mock('../src/middleware/gameRateLimit.middleware.js', () => ({
  gamePlayRateLimiter: (req, res, next) => next(),
  gameSubmitRateLimiter: (req, res, next) => next(),
}))
import router from '../src/routes/game.routes.js'
import User from '../src/models/User.js'
import Vocabulary from '../src/models/Vocabulary.js'
import GameSession from '../src/models/GameSession.js'
import GameResult from '../src/models/GameResult.js'
import GamificationProfile from '../src/models/GamificationProfile.js'
import LevelRule from '../src/models/LevelRule.js'
import RewardGrant from '../src/models/RewardGrant.js'
import XpEvent from '../src/models/XpEvent.js'
import XpQuota from '../src/models/XpQuota.js'
import { ensureDefaultLevelRules } from '../src/services/gamification.service.js'
import { runGameSessionCleanup } from '../src/services/gameSession.scheduler.js'

const app = express()
app.use(express.json())
app.use('/games', router)
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err)
  res.status(err.statusCode || 500).json({ error: err.message })
})

let mongo, student, token

beforeAll(async () => {
  process.env.JWT_SECRET = 'game-hunter-partial-test-only'
  mongo = await MongoMemoryServer.create()
  await mongoose.connect(mongo.getUri())
  await Promise.all([
    GameSession.init(),
    GameResult.init(),
    GamificationProfile.init(),
    LevelRule.init(),
    RewardGrant.init(),
    XpEvent.init(),
  ])
  student = await User.create({
    name: 'Hunter Student',
    email: 'hunter@example.test',
    password: 'test1234',
    role: 'student',
  })
  token = jwt.sign({ id: student.id }, process.env.JWT_SECRET)
  await Vocabulary.create(
    Array.from({ length: 20 }, (_, index) => ({
      student: student._id,
      word: `hunterword${index}`,
      definition: `definition ${index}`,
    })),
  )
}, 180_000)

afterAll(async () => {
  await mongoose.disconnect()
  await mongo?.stop()
})

beforeEach(async () => {
  await Promise.all([
    GameSession.deleteMany({}),
    GameResult.deleteMany({}),
    GamificationProfile.deleteMany({}),
    LevelRule.deleteMany({}),
    RewardGrant.deleteMany({}),
    XpEvent.deleteMany({}),
    XpQuota.deleteMany({}),
  ])
  await ensureDefaultLevelRules()
})

const auth = () => `Bearer ${token}`

const answerCorrect = async (session) => {
  const persisted = await GameSession.findById(session.sessionId).lean()
  const challenge = persisted.challenges[persisted.answers.length]
  const optionId = challenge.options.find((option) => option.id === challenge.answerId).id
  await request(app)
    .post(`/games/hunter/sessions/${session.sessionId}/answers`)
    .set('Authorization', auth())
    .send({ challengeId: challenge.id, optionId, requestId: `answer-${challenge.id}` })
    .expect(200)
}

describe('Vocab Hunter partial finish', () => {
  it('keeps the score of a run that ended early', async () => {
    const started = await request(app)
      .post('/games/hunter/sessions')
      .set('Authorization', auth())
      .send({})
      .expect(201)

    for (let i = 0; i < 4; i += 1) await answerCorrect(started.body.data)
    // Three missed bubbles = the three starting lives, which is what allows an
    // early finish.
    for (let i = 0; i < 3; i += 1) {
      const persisted = await GameSession.findById(started.body.data.sessionId).lean()
      const challenge = persisted.challenges[persisted.answers.length]
      await request(app)
        .post(`/games/hunter/sessions/${started.body.data.sessionId}/answers`)
        .set('Authorization', auth())
        .send({ challengeId: challenge.id, skipped: true, requestId: `skip-${i}` })
        .expect(200)
    }

    const finished = await request(app)
      .post(`/games/hunter/sessions/${started.body.data.sessionId}/finish`)
      .set('Authorization', auth())
      .send({})
      .expect(200)

    expect(finished.body.data.result.correct).toBe(4)
    expect(finished.body.data.result.total).toBe(15)
    expect(finished.body.data.result.score).toBe(400)
    expect(finished.body.data.xpEarned).toBeGreaterThan(0)

    const stored = await GameSession.findById(started.body.data.sessionId).lean()
    expect(stored.answers).toHaveLength(15)
    expect(stored.answers.filter((answer) => answer.skipped)).toHaveLength(11)
  })

  it('refuses to finish before any round was played', async () => {
    const started = await request(app)
      .post('/games/hunter/sessions')
      .set('Authorization', auth())
      .send({})
      .expect(201)

    await request(app)
      .post(`/games/hunter/sessions/${started.body.data.sessionId}/finish`)
      .set('Authorization', auth())
      .send({})
      .expect(409)
  })

  it('still requires every round for the other games', async () => {
    const started = await request(app)
      .post('/games/filler/sessions')
      .set('Authorization', auth())
      .send({ config: { roundCount: 5 } })
      .expect(201)

    await request(app)
      .post(`/games/filler/sessions/${started.body.data.sessionId}/finish`)
      .set('Authorization', auth())
      .send({})
      .expect(409)
  })

  it('returns the same session when start is retried with the same key', async () => {
    const first = await request(app)
      .post('/games/matching/sessions')
      .set('Authorization', auth())
      .send({ config: { pairCount: 4 }, requestId: 'start-key-1' })
      .expect(201)
    const second = await request(app)
      .post('/games/matching/sessions')
      .set('Authorization', auth())
      .send({ config: { pairCount: 4 }, requestId: 'start-key-1' })
      .expect(201)

    expect(second.body.data.sessionId).toBe(first.body.data.sessionId)
    expect(await GameSession.countDocuments({ startKey: 'start-key-1' })).toBe(1)
  })

  it('extends an active session on heartbeat and expires abandoned ones', async () => {
    const started = await request(app)
      .post('/games/matching/sessions')
      .set('Authorization', auth())
      .send({ config: { pairCount: 4 } })
      .expect(201)
    const id = started.body.data.sessionId

    await GameSession.updateOne(
      { _id: id },
      { $set: { expiresAt: new Date(Date.now() + 60_000) } },
    )
    const before = await GameSession.findById(id).lean()
    const heartbeat = await request(app)
      .post(`/games/matching/sessions/${id}/heartbeat`)
      .set('Authorization', auth())
      .send({})
      .expect(200)

    expect(new Date(heartbeat.body.data.expiresAt).getTime())
      .toBeGreaterThan(new Date(before.expiresAt).getTime())

    await GameSession.updateOne(
      { _id: id },
      { $set: { expiresAt: new Date(Date.now() - 2 * 60 * 60 * 1000) } },
    )
    await runGameSessionCleanup()
    expect((await GameSession.findById(id).lean()).status).toBe('expired')
  })

  it('does not let wrong taps unlock an early finish', async () => {
    const started = await request(app)
      .post('/games/hunter/sessions')
      .set('Authorization', auth())
      .send({})
      .expect(201)
    const session = await GameSession.findById(started.body.data.sessionId).lean()
    const challenge = session.challenges[0]
    const wrong = challenge.options.find((option) => option.id !== challenge.answerId)

    for (let i = 0; i < 3; i += 1) {
      await request(app)
        .post(`/games/hunter/sessions/${started.body.data.sessionId}/answers`)
        .set('Authorization', auth())
        .send({ challengeId: challenge.id, optionId: wrong.id, requestId: `wrong-${i}` })
        .expect(200)
    }

    await request(app)
      .post(`/games/hunter/sessions/${started.body.data.sessionId}/finish`)
      .set('Authorization', auth())
      .send({})
      .expect(409)
  })

  it('keeps a scramble round open after a wrong attempt', async () => {
    const started = await request(app)
      .post('/games/scramble/sessions')
      .set('Authorization', auth())
      .send({ config: { roundCount: 5 } })
      .expect(201)
    const session = await GameSession.findById(started.body.data.sessionId).lean()
    const challenge = session.challenges[0]

    const wrong = await request(app)
      .post(`/games/scramble/sessions/${started.body.data.sessionId}/answers`)
      .set('Authorization', auth())
      .send({ challengeId: challenge.id, text: 'zzzz', requestId: 'wrong-1' })
      .expect(200)
    expect(wrong.body.data.correct).toBe(false)

    const fixed = await request(app)
      .post(`/games/scramble/sessions/${started.body.data.sessionId}/answers`)
      .set('Authorization', auth())
      .send({ challengeId: challenge.id, text: challenge.word, requestId: 'fixed-1' })
      .expect(200)
    expect(fixed.body.data.correct).toBe(true)
  })

  it('keeps only one active session when two starts race', async () => {
    const start = () => request(app)
      .post('/games/matching/sessions')
      .set('Authorization', auth())
      .send({ config: { pairCount: 4 } })

    await Promise.all([start(), start()])

    const active = await GameSession.countDocuments({
      student: student._id,
      gameKey: 'matching',
      status: 'active',
    })
    expect(active).toBe(1)
  })

  it('advances to the next round after a skip', async () => {
    const started = await request(app)
      .post('/games/scramble/sessions')
      .set('Authorization', auth())
      .send({ config: { roundCount: 5 } })
      .expect(201)
    const session = await GameSession.findById(started.body.data.sessionId).lean()

    const skipped = await request(app)
      .post(`/games/scramble/sessions/${started.body.data.sessionId}/answers`)
      .set('Authorization', auth())
      .send({ challengeId: session.challenges[0].id, text: '', skipped: true, requestId: 'skip-1' })
      .expect(200)
    expect(skipped.body.data.nextChallenge.id).toBe(session.challenges[1].id)

    const next = await request(app)
      .post(`/games/scramble/sessions/${started.body.data.sessionId}/answers`)
      .set('Authorization', auth())
      .send({ challengeId: session.challenges[1].id, text: session.challenges[1].word, requestId: 'next-1' })
      .expect(200)
    expect(next.body.data.correct).toBe(true)
  })

  it('prefers words that are due for SRS over recently saved words', async () => {
    const dueWords = Array.from({ length: 15 }, (_, index) => ({
      student: student._id,
      word: `dueword${index}`,
      definition: `due definition ${index}`,
      masteryLevel: 'learning',
      nextReviewDate: new Date(Date.now() - 24 * 60 * 60 * 1000),
    }))
    const freshWords = Array.from({ length: 100 }, (_, index) => ({
      student: student._id,
      word: `freshword${index}`,
      definition: `fresh definition ${index}`,
      masteryLevel: 'new',
    }))
    const created = await Vocabulary.create([...dueWords, ...freshWords])

    try {
      const started = await request(app)
        .post('/games/hunter/sessions')
        .set('Authorization', auth())
        .send({})
        .expect(201)

      const targets = started.body.data.challenges.map((challenge) => challenge.targetWord).sort()
      expect(targets).toEqual(dueWords.map((word) => word.word).sort())
    } finally {
      await Vocabulary.deleteMany({ _id: { $in: created.map((word) => word._id) } })
    }
  })

  it('refuses to start a game when the library is too small', async () => {
    const emptyStudent = await User.create({
      name: 'Empty Library',
      email: 'empty@example.test',
      password: 'test1234',
      role: 'student',
    })
    const emptyToken = jwt.sign({ id: emptyStudent.id }, process.env.JWT_SECRET)

    const res = await request(app)
      .post('/games/matching/sessions')
      .set('Authorization', `Bearer ${emptyToken}`)
      .send({ config: { pairCount: 4 } })
      .expect(409)

    expect(res.body.error).toMatch(/at least 4 words/i)
  })
})

import { beforeAll, afterAll, afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
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
import GameSession from '../src/models/GameSession.js'
import Vocabulary from '../src/models/Vocabulary.js'
import GameResult from '../src/models/GameResult.js'
import GamificationProfile from '../src/models/GamificationProfile.js'
import LevelRule from '../src/models/LevelRule.js'
import RewardGrant from '../src/models/RewardGrant.js'
import XpEvent from '../src/models/XpEvent.js'
import XpQuota from '../src/models/XpQuota.js'
import { ensureDefaultLevelRules } from '../src/services/gamification.service.js'

const app = express()
app.use(express.json())
app.use('/games', router)
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err)
  res.status(err.statusCode || 500).json({ error: err.message })
})

let mongo, student, token

beforeAll(async () => {
  process.env.JWT_SECRET = 'game-route-test-only'
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
    name: 'Game Route Student',
    email: 'game-route@example.test',
    password: 'test1234',
    role: 'student',
  })
  token = jwt.sign({ id: student.id }, process.env.JWT_SECRET)
  await Vocabulary.create(
    Array.from({ length: 20 }, (_, index) => ({
      student: student._id,
      word: `gameword${index}`,
      definition: `definition ${index}`,
    })),
  )
}, 180_000)

afterAll(async () => {
  await mongoose.disconnect()
  await mongo?.stop()
})

afterEach(() => {
  vi.restoreAllMocks()
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

describe('game result API', () => {
  async function answerEveryChallenge(gameKey, session) {
    const persisted = await GameSession.findById(session.sessionId).lean()
    for (const challenge of persisted.challenges) {
      const optionId = challenge.options?.find(option => option.id === challenge.answerId)?.id
      await request(app)
        .post(`/games/${gameKey}/sessions/${session.sessionId}/answers`)
        .set('Authorization', auth())
        .send({
          challengeId: challenge.id,
          requestId: `test-${challenge.id}`,
          ...(gameKey === 'scramble' ? { text: challenge.word } : { optionId }),
        })
        .expect(200)
    }
  }

  it('records an incorrect and skipped answer before allowing the next round', async () => {
    const started = await request(app).post('/games/filler/sessions').set('Authorization', auth()).send({ config: { roundCount: 5 } }).expect(201)
    const challenge = (await GameSession.findById(started.body.data.sessionId).lean()).challenges[0]
    const wrong = challenge.options.find(option => option.id !== challenge.answerId)
    const response = await request(app)
      .post(`/games/filler/sessions/${started.body.data.sessionId}/answers`)
      .set('Authorization', auth())
      .send({ challengeId: challenge.id, requestId: 'wrong-choice', optionId: wrong.id })
      .expect(200)
    expect(response.body.data.correct).toBe(false)
    expect(response.body.data.nextChallenge.id).toBe((await GameSession.findById(started.body.data.sessionId).lean()).challenges[1].id)
    expect((await GameSession.findById(started.body.data.sessionId).lean()).answers[0]).toMatchObject({ correct: false, completed: true })
  })

  it('rejects client-forged summaries until all server challenges are answered', async () => {
    const started = await request(app).post('/games/filler/sessions').set('Authorization', auth()).send({ config: { roundCount: 5 } }).expect(201)
    await request(app).post(`/games/filler/sessions/${started.body.data.sessionId}/finish`).set('Authorization', auth()).send({ correct: 5, total: 5, score: 99999 }).expect(409)
    await answerEveryChallenge('filler', started.body.data)
    const completed = await request(app).post(`/games/filler/sessions/${started.body.data.sessionId}/finish`).set('Authorization', auth()).send({ correct: 5, total: 5, score: 99999 }).expect(200)
    expect(completed.body.data.result.total).toBe(5)
    expect(completed.body.data.result.score).toBe(5)
  })

  it('starts and finishes a game once, then replays the stored result', async () => {
    const started = await request(app)
      .post('/games/hunter/sessions')
      .set('Authorization', auth())
      .send({ config: { speedLevel: 'fast' } })
      .expect(201)
    expect(started.body.data.sessionId).toBeTruthy()
    expect(started.body.data.expectedRounds).toBe(15)

    await answerEveryChallenge('hunter', started.body.data)
    const body = { score: 999999, correct: 0, total: 1 }
    const first = await request(app)
      .post(`/games/hunter/sessions/${started.body.data.sessionId}/finish`)
      .set('Authorization', auth())
      .send(body)
      .expect(200)
    expect(first.body.data.xpEarned).toBe(25)
    expect(first.body.data.replayed).toBe(false)

    const second = await request(app)
      .post(`/games/hunter/sessions/${started.body.data.sessionId}/finish`)
      .set('Authorization', auth())
      .send(body)
      .expect(200)
    expect(second.body.data.xpEarned).toBe(25)
    expect(second.body.data.replayed).toBe(true)
    expect(await GameResult.countDocuments()).toBe(1)
  })

  it('recovers a claimed finish after result persistence fails', async () => {
    const started = await request(app)
      .post('/games/hunter/sessions')
      .set('Authorization', auth())
      .send({ config: { speedLevel: 'medium' } })
      .expect(201)
    await answerEveryChallenge('hunter', started.body.data)
    const body = { score: 9000, correct: 2, total: 1 }

    vi.spyOn(GameResult, 'findOneAndUpdate').mockRejectedValueOnce(new Error('injected result write failure'))
    await request(app)
      .post('/games/hunter/sessions/' + started.body.data.sessionId + '/finish')
      .set('Authorization', auth())
      .send(body)
      .expect(500)

    const claimed = await GameSession.findById(started.body.data.sessionId)
    expect(claimed.status).toBe('finishing')
    expect(claimed.finishPayload.total).toBe(15)
    expect(claimed.finishPayload.score).toBe(1500)
    expect(claimed.finishPayload.correct).toBe(15)
    expect(claimed.finishingAt).toBeInstanceOf(Date)
    expect(await GameResult.countDocuments()).toBe(0)
    await GameSession.updateOne(
      { _id: started.body.data.sessionId },
      { $set: { expiresAt: new Date(Date.now() - 1000) } },
    )

    const recovered = await request(app)
      .post('/games/hunter/sessions/' + started.body.data.sessionId + '/finish')
      .set('Authorization', auth())
      .send({ score: 0, correct: 0, total: 1, durationMs: 0 })
      .expect(200)

    expect(recovered.body.data.result).toMatchObject({ score: 1500, correct: 15, total: 15 })
    expect(await GameResult.countDocuments()).toBe(1)
    expect((await GameSession.findById(started.body.data.sessionId)).status).toBe('finished')
  })

  it('rejects a legacy finished session without its persisted result', async () => {
    const started = await request(app)
      .post('/games/scramble/sessions')
      .set('Authorization', auth())
      .send({ config: { roundCount: 5 } })
      .expect(201)
    await GameSession.updateOne(
      { _id: started.body.data.sessionId },
      { $set: { status: 'finished', finishedAt: new Date(), finishPayload: null, expiresAt: new Date(Date.now() + 60_000) } },
    )
    await request(app)
      .post('/games/scramble/sessions/' + started.body.data.sessionId + '/finish')
      .set('Authorization', auth())
      .send({ score: 5000, correct: 5000, total: 0 })
      .expect(409)
    expect(await GameResult.countDocuments()).toBe(0)
  })

  it('recovers after result creation when saving its XP amount fails', async () => {
    const started = await request(app)
      .post('/games/scramble/sessions')
      .set('Authorization', auth())
      .send({ config: { roundCount: 5 } })
      .expect(201)
    await answerEveryChallenge('scramble', started.body.data)
    const body = { score: 4, correct: 4, total: 5, durationMs: 10_000, meta: { bestStreak: 4 } }

    vi.spyOn(GameResult, 'updateOne').mockRejectedValueOnce(new Error('injected result update failure'))
    await request(app)
      .post('/games/scramble/sessions/' + started.body.data.sessionId + '/finish')
      .set('Authorization', auth())
      .send(body)
      .expect(500)

    expect(await GameResult.countDocuments()).toBe(1)
    expect((await GameResult.findOne({ session: started.body.data.sessionId })).xpEarned).toBe(0)
    expect((await GameSession.findById(started.body.data.sessionId)).status).toBe('finishing')
    expect(await XpEvent.countDocuments({ sourceType: 'game' })).toBe(1)

    const recovered = await request(app)
      .post('/games/scramble/sessions/' + started.body.data.sessionId + '/finish')
      .set('Authorization', auth())
      .send(body)
      .expect(200)

    expect(recovered.body.data.result.xpEarned).toBe(25)
    expect(recovered.body.data.replayed).toBe(true)
    expect(await XpEvent.countDocuments({ sourceType: 'game' })).toBe(1)
    expect((await GameSession.findById(started.body.data.sessionId)).status).toBe('finished')
  })

  it('derives scores and rejects impossible matching summaries', async () => {
    const started = await request(app)
      .post('/games/matching/sessions')
      .set('Authorization', auth())
      .send({ config: { pairCount: 4 } })
      .expect(201)

    await request(app)
      .post('/games/matching/sessions/' + started.body.data.sessionId + '/finish')
      .set('Authorization', auth())
      .send({})
      .expect(409)
    expect((await GameSession.findById(started.body.data.sessionId)).status).toBe('active')
    expect(await GameResult.countDocuments()).toBe(0)
  })

  it('handles concurrent duplicate finish requests once', async () => {
    const started = await request(app)
      .post('/games/filler/sessions')
      .set('Authorization', auth())
      .send({ config: { roundCount: 5 } })
      .expect(201)
    await answerEveryChallenge('filler', started.body.data)
    const finishUrl = '/games/filler/sessions/' + started.body.data.sessionId + '/finish'
    const responses = await Promise.all([
      request(app).post(finishUrl).set('Authorization', auth()).send({}),
      request(app).post(finishUrl).set('Authorization', auth()).send({}),
    ])
    expect(responses.map(({ status }) => status)).toEqual([200, 200])
    expect(await GameResult.countDocuments()).toBe(1)
    expect(await XpEvent.countDocuments({ sourceType: 'game' })).toBe(1)
    expect((await GameSession.findById(started.body.data.sessionId)).status).toBe('finished')
  })

  it('rejects an expired session', async () => {
    const started = await request(app)
      .post('/games/scramble/sessions')
      .set('Authorization', auth())
      .send({ config: { roundCount: 5 } })
      .expect(201)
    await GameSession.updateOne({ _id: started.body.data.sessionId }, { $set: { expiresAt: new Date(Date.now() - 1000) } })
    await request(app)
      .post(`/games/scramble/sessions/${started.body.data.sessionId}/finish`)
      .set('Authorization', auth())
      .send({})
      .expect(410)
  })
})

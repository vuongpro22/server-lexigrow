import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest'
import mongoose from 'mongoose'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import app from '../src/app.js'
import User from '../src/models/User.js'
import Vocabulary from '../src/models/Vocabulary.js'
import WordUsageEvidence from '../src/models/WordUsageEvidence.js'

let mongo
let student
let token

const auth = (req) => req.set('Authorization', 'Bearer ' + token)

beforeAll(async () => {
  process.env.JWT_SECRET = 'test-only-mastery-secret'
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } })
  await mongoose.connect(mongo.getUri())
  await Promise.all(Object.values(mongoose.models).map((model) => model.init()))
}, 120000)

afterAll(async () => {
  await mongoose.disconnect()
  if (mongo) await mongo.stop()
}, 30000)

beforeEach(async () => {
  await Promise.all(Object.values(mongoose.models).map((model) => model.deleteMany({})))
  student = await User.create({
    name: 'Student',
    email: 'student@example.test',
    password: 'password1',
    role: 'student',
    accountStatus: 'active',
  })
  token = jwt.sign({ id: student.id }, process.env.JWT_SECRET)
})

const evidence = (word, day) => ({
  student: student._id,
  word,
  contextSentence: `I used ${word} on ${day}.`,
  essayId: new mongoose.Types.ObjectId(),
  revisionId: new mongoose.Types.ObjectId(),
  theme: 'Academic',
  meaning: 'meaning of ' + word,
  isVerifiedCorrect: true,
  assisted: false,
  localDay: day,
  usedAt: new Date(`${day}T03:00:00.000Z`),
})

describe('Mastery has a single source of truth (verified essay evidence)', () => {
  it('shows a word as mastered only after two independent essays on two days', async () => {
    const word = await Vocabulary.create({
      student: student._id,
      word: 'lucid',
      definition: 'clear',
    })
    await WordUsageEvidence.create([evidence('lucid', '2026-11-01')])

    const oneEssay = await auth(request(app).get('/api/vocabulary')).expect(200)
    expect(oneEssay.body.data[0].masteryLevel).toBe('new')
    expect(oneEssay.body.data[0].isMastered).toBe(false)

    await WordUsageEvidence.create([evidence('lucid', '2026-11-02')])

    const twoEssays = await auth(request(app).get('/api/vocabulary')).expect(200)
    expect(twoEssays.body.data[0].masteryLevel).toBe('mastered')
    expect(twoEssays.body.data[0].isMastered).toBe(true)
    expect(twoEssays.body.data[0]._id).toBe(word.id)
  })

  it('counts mastered words from evidence, not from the stored SRS level', async () => {
    await Vocabulary.create([
      { student: student._id, word: 'lucid', category: 'academic', masteryLevel: 'mastered' },
      { student: student._id, word: 'vivid', category: 'academic', masteryLevel: 'learning' },
    ])
    await WordUsageEvidence.create([
      evidence('vivid', '2026-11-01'),
      evidence('vivid', '2026-11-02'),
    ])

    const stats = await auth(request(app).get('/api/vocabulary/stats')).expect(200)
    expect(stats.body.masteryDistribution.mastered).toBe(1)
    expect(stats.body.masteryDistribution.learning).toBe(1)
    expect(stats.body.masteryDistribution.new).toBe(0)
  })

  it('filters the library by the evidence-derived mastered state', async () => {
    await Vocabulary.create([
      { student: student._id, word: 'lucid' },
      { student: student._id, word: 'vivid' },
    ])
    await WordUsageEvidence.create([
      evidence('vivid', '2026-11-01'),
      evidence('vivid', '2026-11-02'),
    ])

    const mastered = await auth(request(app).get('/api/vocabulary?mastery=mastered')).expect(200)
    expect(mastered.body.data.map((word) => word.word)).toEqual(['vivid'])

    const learning = await auth(request(app).get('/api/vocabulary?mastery=new')).expect(200)
    expect(learning.body.data.map((word) => word.word)).toEqual(['lucid'])
  })

  it('marks evidence rows mastered only when the word meets the standard', async () => {
    await WordUsageEvidence.create([
      evidence('lucid', '2026-11-01'),
      evidence('lucid', '2026-11-02'),
      evidence('faint', '2026-11-01'),
    ])

    const res = await auth(request(app).get('/api/progress/evidence')).expect(200)
    const byWord = res.body.data.reduce((map, row) => {
      map[row.word] = row.isMastered
      return map
    }, {})
    expect(byWord.lucid).toBe(true)
    expect(byWord.faint).toBe(false)
  })

  it('treats a stored mastered word without evidence as learning in the filter', async () => {
    await Vocabulary.create({ student: student._id, word: 'stale', masteryLevel: 'mastered' })

    const res = await auth(request(app).get('/api/vocabulary?mastery=learning')).expect(200)
    expect(res.body.data.map((word) => word.word)).toContain('stale')
  })

  it('keeps the mastered level in the review response when evidence exists', async () => {
    const word = await Vocabulary.create({ student: student._id, word: 'vivid' })
    await WordUsageEvidence.create([
      evidence('vivid', '2026-11-01'),
      evidence('vivid', '2026-11-02'),
    ])

    const res = await auth(request(app).post('/api/vocabulary/review'))
      .send({ wordId: word.id, rating: 3, requestId: 'effective-mastery' })
      .expect(200)

    expect(res.body.data.word.masteryLevel).toBe('mastered')
    expect(res.body.data.word.isMastered).toBe(true)
  })

  it('never marks a word mastered through repeated reviews', async () => {
    const word = await Vocabulary.create({
      student: student._id,
      word: 'lucid',
      definition: 'clear',
    })

    for (let i = 0; i < 8; i += 1) {
      await Vocabulary.updateOne({ _id: word._id }, { $set: { nextReviewDate: null } })
      await auth(request(app).post('/api/vocabulary/review'))
        .send({ wordId: word.id, rating: 4, requestId: `mastery-review-${i}` })
        .expect(200)
    }

    const stored = await Vocabulary.findById(word._id).lean()
    expect(stored.reviewCount).toBeGreaterThanOrEqual(4)
    expect(stored.masteryLevel).toBe('learning')

    const list = await auth(request(app).get('/api/vocabulary')).expect(200)
    expect(list.body.data[0].masteryLevel).toBe('learning')
    expect(list.body.data[0].isMastered).toBe(false)
  }, 20000)
})

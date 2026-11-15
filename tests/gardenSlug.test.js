import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest'
import mongoose from 'mongoose'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import app from '../src/app.js'
import User from '../src/models/User.js'
import LearningSet from '../src/models/LearningSet.js'
import LearningSession from '../src/models/LearningSession.js'
import WordUsageEvidence from '../src/models/WordUsageEvidence.js'

let mongo
let student
let token
let set

const auth = (req) => req.set('Authorization', 'Bearer ' + token)

beforeAll(async () => {
  process.env.JWT_SECRET = 'test-only-garden-slug-secret'
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
  set = await LearningSet.create({
    slug: 'daily-life',
    title: 'Daily Life & Productivity',
    description: 'Everyday vocabulary',
    level: 'B1',
    category: 'Daily',
    status: 'published',
    items: [{ word: 'lucid', partOfSpeech: 'adj', definitionVi: 'rõ ràng', quizQuestions: [] }],
  })
})

const plant = (theme, words = ['lucid']) =>
  LearningSession.create({
    student: student._id,
    learningSet: set._id,
    learningSetSlug: set.slug,
    theme,
    targetWords: words.map((word) => ({ word })),
    status: 'completed',
  })

const evidence = (word, theme, day) => ({
  student: student._id,
  word,
  contextSentence: `I used ${word} on ${day}.`,
  essayId: new mongoose.Types.ObjectId(),
  revisionId: new mongoose.Types.ObjectId(),
  theme,
  meaning: 'meaning of ' + word,
  isVerifiedCorrect: true,
  assisted: false,
  localDay: day,
})

describe('GET /api/garden/status — linkable topics and distinct mastery', () => {
  it('returns the published learning set slug instead of the display title', async () => {
    await plant('Daily Life & Productivity')
    const res = await auth(request(app).get('/api/garden/status')).expect(200)

    expect(res.body.data).toHaveLength(1)
    expect(res.body.data[0].theme).toBe('Daily Life & Productivity')
    expect(res.body.data[0].learningSetSlug).toBe('daily-life')
    expect(res.body.data[0].slug).toBe('daily-life')
  })

  it('counts a word used in two themes once in the garden total', async () => {
    await plant('Daily Life & Productivity')
    await plant('Travel')
    await WordUsageEvidence.create([
      evidence('lucid', 'Daily Life & Productivity', '2026-11-01'),
      evidence('lucid', 'Travel', '2026-11-02'),
    ])

    const res = await auth(request(app).get('/api/garden/status')).expect(200)
    expect(res.body.totalMasteredDistinct).toBe(1)
    expect(res.body.data.map((row) => row.masteredCount)).toEqual([1, 1])

    // The detail panel needs the word and the essay sentence that backs it.
    const topic = res.body.data.find((row) => row.theme === 'Daily Life & Productivity')
    expect(topic.words).toEqual([
      expect.objectContaining({
        word: 'lucid',
        status: 'mastered',
        evidence: expect.stringContaining('I used lucid'),
      }),
    ])
  })

  it('accepts the learning set slug when watering a plant', async () => {
    await plant('Daily Life & Productivity')
    const res = await auth(request(app).post('/api/garden/water'))
      .send({ slug: 'daily-life' })
      .expect(200)

    expect(res.body.data.theme).toBe('Daily Life & Productivity')
    expect(res.body.data.learningSetSlug).toBe('daily-life')
  })
})

import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest'
import mongoose from 'mongoose'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import app from '../src/app.js'
import User from '../src/models/User.js'
import Vocabulary from '../src/models/Vocabulary.js'
import ReviewEvent from '../src/models/ReviewEvent.js'
import XpAwardOutbox from '../src/models/XpAwardOutbox.js'

let mongo
let student
let token
let word

const auth = (req, t = token) => req.set('Authorization', 'Bearer ' + t)

beforeAll(async () => {
  process.env.JWT_SECRET = 'test-only-vocabulary-review-secret'
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
  word = await Vocabulary.create({
    student: student._id,
    word: 'lucid',
    definition: 'clear and easy to understand',
    nextReviewDate: null,
  })
})

const review = (body) => auth(request(app).post('/api/vocabulary/review')).send(body)

describe('POST /api/vocabulary/review — unified SRS engine', () => {
  it('records a ReviewEvent and makes the day count towards the streak', async () => {
    const res = await review({ wordId: word.id, rating: 3, requestId: 'review-1' }).expect(200)

    expect(res.body.success).toBe(true)
    expect(res.body.data.reviewCount).toBe(1)
    expect(res.body.data.reviewInterval).toBe(1)

    const events = await ReviewEvent.find({ student: student._id }).lean()
    expect(events).toHaveLength(1)
    expect(events[0].requestId).toBe('review-1')
    expect(events[0].rating).toBe(3)

    const streak = await auth(request(app).get('/api/progress/streak')).expect(200)
    expect(streak.body.data.streakDays).toBe(1)
    expect(streak.body.data.hasActivityToday).toBe(true)
  })

  it('replays the same idempotency key without scheduling or paying twice', async () => {
    const first = await review({ wordId: word.id, rating: 3, requestId: 'same-key' }).expect(200)
    const second = await review({ wordId: word.id, rating: 3, requestId: 'same-key' }).expect(200)

    expect(first.body.replayed).toBe(false)
    expect(second.body.replayed).toBe(true)
    expect(second.body.data.reviewCount).toBe(first.body.data.reviewCount)
    await expect(ReviewEvent.countDocuments({ student: student._id })).resolves.toBe(1)
  })

  it('refuses to review a word before its due date', async () => {
    const future = new Date()
    future.setDate(future.getDate() + 3)
    await Vocabulary.updateOne({ _id: word._id }, { $set: { nextReviewDate: future } })

    const res = await review({ wordId: word._id.toString(), rating: 3, requestId: 'early' }).expect(409)
    expect(res.body.error).toMatch(/not due/i)
    await expect(ReviewEvent.countDocuments({ student: student._id })).resolves.toBe(0)
  })

  it('keeps the streak when the learner rates a review as hard', async () => {
    await Vocabulary.updateOne(
      { _id: word._id },
      { $set: { reviewCount: 2, reviewInterval: 6, easeFactor: 2.5, nextReviewDate: null } },
    )

    const res = await review({ wordId: word.id, rating: 2, requestId: 'hard-1' }).expect(200)
    expect(res.body.data.reviewCount).toBe(3)
    expect(res.body.data.reviewInterval).toBe(7)
  })

  it('stamps the review day into the XP job key', async () => {
    await review({ wordId: word.id, rating: 3, requestId: 'key-day' }).expect(200)

    const job = await XpAwardOutbox.findOne({ student: student._id }).lean()
    expect(job?.jobKey).toMatch(/^vocabulary_review:.+:\d{4}-\d{2}-\d{2}:1$/)
  })

  it('rejects an early review through the legacy SRS endpoint too', async () => {
    const future = new Date()
    future.setDate(future.getDate() + 3)
    await Vocabulary.updateOne({ _id: word._id }, { $set: { nextReviewDate: future } })

    await auth(request(app).post('/api/srs/review'))
      .send({ vocabularyId: word.id, rating: 3, requestId: 'srs-early' })
      .expect(409)
  })

  it('rejects a review for a word owned by another student', async () => {
    const other = await User.create({
      name: 'Other',
      email: 'other@example.test',
      password: 'password1',
      role: 'student',
      accountStatus: 'active',
    })
    const otherToken = jwt.sign({ id: other.id }, process.env.JWT_SECRET)

    await auth(request(app).post('/api/vocabulary/review'), otherToken)
      .send({ wordId: word.id, rating: 3, requestId: 'stolen' })
      .expect(404)
  })
})

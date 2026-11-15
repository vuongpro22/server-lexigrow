import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest'
import mongoose from 'mongoose'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import app from '../src/app.js'
import User from '../src/models/User.js'
import Vocabulary from '../src/models/Vocabulary.js'
import { dayBoundary } from '../src/utils/learning.js'

let mongo
let student
let token
const zone = 'America/Los_Angeles'

const auth = (req) => req.set('Authorization', 'Bearer ' + token)

beforeAll(async () => {
  process.env.JWT_SECRET = 'test-only-due-timezone-secret'
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
    learningProfile: { timezone: zone },
  })
  token = jwt.sign({ id: student.id }, process.env.JWT_SECRET)
})

describe('GET /api/vocabulary/due-today timezone handling', () => {
  it('includes words due today and excludes words due at local midnight tomorrow', async () => {
    const now = new Date()
    const today = dayBoundary(now, 0, zone)
    const tomorrow = dayBoundary(now, 1, zone)

    await Vocabulary.create([
      { student: student._id, word: 'today', nextReviewDate: today },
      { student: student._id, word: 'tomorrow', nextReviewDate: tomorrow },
      { student: student._id, word: 'never' },
    ])

    const res = await auth(request(app).get('/api/vocabulary/due-today')).expect(200)
    expect(res.body.timezone).toBe(zone)
    expect(res.body.data.map((word) => word.word).sort()).toEqual(['never', 'today'])

    // The library badge must use the same boundary as the review deck.
    const library = await auth(request(app).get('/api/vocabulary')).expect(200)
    expect(library.body.dueCount).toBe(2)
  })
})

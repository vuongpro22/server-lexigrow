import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest'
import mongoose from 'mongoose'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import app from '../src/app.js'
import User from '../src/models/User.js'
import Class from '../src/models/Class.js'
import Vocabulary from '../src/models/Vocabulary.js'
import WordUsageEvidence from '../src/models/WordUsageEvidence.js'

let mongo
let teacher
let student
let teacherToken

const auth = (req) => req.set('Authorization', 'Bearer ' + teacherToken)

beforeAll(async () => {
  process.env.JWT_SECRET = 'test-only-mastery-report-secret'
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
  ;[teacher, student] = await User.create([
    {
      name: 'Teacher',
      email: 'teacher@example.test',
      password: 'password1',
      role: 'teacher',
      accountStatus: 'active',
    },
    {
      name: 'Student',
      email: 'student@example.test',
      password: 'password1',
      role: 'student',
      accountStatus: 'active',
    },
  ])
  teacherToken = jwt.sign({ id: teacher.id }, process.env.JWT_SECRET)
  await Class.create({ name: 'Class 10A', teacher: teacher._id, students: [student._id] })

  await Vocabulary.create([
    { student: student._id, word: 'vivid', category: 'academic', masteryLevel: 'learning' },
    { student: student._id, word: 'stale', category: 'academic', masteryLevel: 'mastered' },
  ])

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
  })
  await WordUsageEvidence.create([
    evidence('vivid', '2026-11-01'),
    evidence('vivid', '2026-11-02'),
  ])
})

describe('Teacher vocabulary report uses the evidence pipeline', () => {
  it('counts and labels mastery from evidence, not the stored recognition level', async () => {
    const res = await auth(request(app).get(`/api/teacher/students/${student.id}/vocabulary`)).expect(200)

    expect(res.body.data.masteryDistribution.mastered).toBe(1)
    expect(res.body.data.masteryDistribution.learning).toBe(1)
    expect(res.body.data.masteredCount).toBe(1)

    const byWord = Object.fromEntries(res.body.data.words.map((word) => [word.word, word.masteryLevel]))
    expect(byWord.vivid).toBe('mastered')
    expect(byWord.stale).toBe('learning')
  })

  it('filters mastered and learning with the same definition', async () => {
    const mastered = await auth(
      request(app).get(`/api/teacher/students/${student.id}/vocabulary?mastery=mastered`),
    ).expect(200)
    expect(mastered.body.data.words.map((word) => word.word)).toEqual(['vivid'])

    const learning = await auth(
      request(app).get(`/api/teacher/students/${student.id}/vocabulary?mastery=learning`),
    ).expect(200)
    expect(learning.body.data.words.map((word) => word.word)).toEqual(['stale'])
  })
})

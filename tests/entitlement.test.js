import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import mongoose from 'mongoose'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import app from '../src/app.js'
import User from '../src/models/User.js'
import LearningSet from '../src/models/LearningSet.js'
import Subscription from '../src/models/Subscription.js'
import SubscriptionPlan from '../src/models/SubscriptionPlan.js'
import { learningSetCache } from '../src/services/learningCache.service.js'
import { FREE_LEARNING_SET_LEVELS } from '../src/middleware/entitlement.middleware.js'

let mongo, freeStudent, plusStudent, admin, token, otherToken, adminToken, plusPlan
const auth = (r, t = token) => r.set('Authorization', 'Bearer ' + t)

const makeSet = (slug, level) => ({
  slug,
  title: slug,
  description: slug,
  level,
  category: 'Basics',
  status: 'published',
  items: [{ word: 'word', partOfSpeech: 'noun', definitionVi: 'nghĩa', quizQuestions: [] }],
})

const grantPlus = () => Subscription.create({
  user: plusStudent._id,
  plan: plusPlan._id,
  planSlug: plusPlan.slug,
  targetRole: 'student',
  tier: 'plus',
  billingCycle: 'monthly',
  amountPaid: 59000,
  orderCode: 4242,
  startDate: new Date(Date.now() - 86400000),
  endDate: new Date(Date.now() + 30 * 24 * 3600 * 1000),
})

beforeAll(async () => {
  process.env.JWT_SECRET = 'test-only-entitlement-secret'
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } })
  await mongoose.connect(mongo.getUri())
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()))
}, 120000)
afterAll(async () => {
  await mongoose.disconnect()
  if (mongo) await mongo.stop()
}, 30000)

beforeEach(async () => {
  learningSetCache.clear()
  await Promise.all(Object.values(mongoose.models).map((m) => m.deleteMany({})))
  const users = await User.create([
    { name: 'Free', email: 'free@example.test', password: 'password1' },
    { name: 'Plus', email: 'plus@example.test', password: 'password1' },
    { name: 'Admin', email: 'admin@example.test', password: 'password1', role: 'admin' },
  ])
  ;[freeStudent, plusStudent, admin] = users
  token = jwt.sign({ id: freeStudent.id }, process.env.JWT_SECRET)
  otherToken = jwt.sign({ id: plusStudent.id }, process.env.JWT_SECRET)
  adminToken = jwt.sign({ id: admin.id }, process.env.JWT_SECRET)
  plusPlan = await SubscriptionPlan.create({
    slug: 'student-plus-test', name: 'Student Plus', targetRole: 'student', tier: 'plus',
    monthlyPrice: 59000, yearlyPrice: 499000, dailyAiEssayLimit: 15, isActive: true,
  })
  // Level decides the Free boundary: A2/B1 are foundational, B2/C1 are paid.
  await LearningSet.create([
    makeSet('a2-set', 'A2'),
    makeSet('b1-set', 'B1'),
    makeSet('b2-set', 'B2'),
    makeSet('c1-set', 'C1'),
  ])
})

describe('PAY-02 entitlement enforcement', () => {
  it('shows a Free account every foundational-level set', async () => {
    const res = await auth(request(app).get('/api/learning-sets/explore')).expect(200)
    expect(res.body.data.map((s) => s.slug)).toEqual(['a2-set', 'b1-set'])
    expect(res.body.data.every((s) => FREE_LEARNING_SET_LEVELS.includes(s.level))).toBe(true)
  })

  it('allows students and admins to read round counts, but rejects anonymous callers', async () => {
    await auth(request(app).get('/api/sessions/round-counts')).expect(200)
    await auth(request(app).get('/api/sessions/round-counts'), adminToken).expect(200)
    await request(app).get('/api/sessions/round-counts').expect(401)
  })

  it('shows the whole library to a paid account', async () => {
    await grantPlus()
    const res = await auth(request(app).get('/api/learning-sets/explore'), otherToken).expect(200)
    expect(res.body.data.map((s) => s.slug)).toEqual(['a2-set', 'b1-set', 'b2-set', 'c1-set'])
  })

  it('paginates the Free library without leaking locked sets or a locked total', async () => {
    const res = await auth(request(app).get('/api/learning-sets?page=1&limit=10')).expect(200)
    expect(res.body.data.map((s) => s.slug)).toEqual(['a2-set', 'b1-set'])
    expect(res.body.pagination.total).toBe(2)
  })

  it('does not let a Free account widen the level filter', async () => {
    const res = await auth(request(app).get('/api/learning-sets?level=C1')).expect(200)
    expect(res.body.data).toEqual([])
    expect(res.body.pagination.total).toBe(0)
  })

  it('answers a locked slug exactly like a missing one', async () => {
    await auth(request(app).get('/api/learning-sets/c1-set')).expect(404)
    await auth(request(app).get('/api/learning-sets/b1-set')).expect(200)
    await grantPlus()
    await auth(request(app).get('/api/learning-sets/c1-set'), otherToken).expect(200)
  })

  // Reading the set endpoint is not enough: starting a session returns the words
  // themselves, so the same boundary has to guard the write path.
  it('refuses to start a learning session on a locked set', async () => {
    const locked = await auth(request(app).post('/api/sessions/start'))
      .send({ learningSetSlug: 'c1-set' })
    expect(locked.status).toBe(404)
    expect(await mongoose.model('LearningSession').countDocuments()).toBe(0)

    const allowed = await auth(request(app).post('/api/sessions/start'))
      .send({ learningSetSlug: 'b1-set' })
    expect(allowed.status).toBe(201)
  })

  it('lets a paid account start a session on a locked set', async () => {
    await grantPlus()
    const res = await auth(request(app).post('/api/sessions/start'), otherToken)
      .send({ learningSetSlug: 'c1-set' })
    expect(res.status).toBe(201)
    expect(res.body.data.targetWords.length).toBeGreaterThan(0)
  })

  // A session created while sponsored keeps its words in the database. After the
  // plan lapses, both the "continue" shortcut and the current-session read must
  // stop returning them.
  it('blocks essay-session lookup, reopen, and step updates after the set entitlement lapses', async () => {
    const LearningSession = mongoose.model('LearningSession')
    const lockedSet = await LearningSet.findOne({ slug: 'c1-set' })
    const essay = await (await import('../src/models/Essay.js')).default.create({
      student: freeStudent._id,
      title: 'Previously paid essay',
      content: 'This essay belongs to a formerly paid learning set.',
      status: 'submitted',
    })
    const session = await LearningSession.create({
      student: freeStudent._id,
      originalEssay: essay._id,
      learningSet: lockedSet._id,
      learningSetSlug: lockedSet.slug,
      theme: lockedSet.title,
      level: lockedSet.level,
      mode: 'static',
      status: 'completed',
      currentStep: 'completed',
      targetWords: [{ word: 'revenue', partOfSpeech: 'noun', definitionVi: 'doanh thu' }],
    })

    await auth(request(app).get(`/api/sessions/by-essay/${essay._id}`)).expect(404)
    await auth(request(app).patch(`/api/sessions/${session._id}/reopen-for-revision`))
      .send({ essayId: essay._id }).expect(404)
    await auth(request(app).put(`/api/sessions/${session._id}/step`))
      .send({ currentStep: 'completed' }).expect(404)

    const persisted = await LearningSession.findById(session._id)
    expect(persisted.status).toBe('completed')
    expect(persisted.currentStep).toBe('completed')
  })

  it('stops handing back a stale session whose set is no longer accessible', async () => {
    const LearningSession = mongoose.model('LearningSession')
    const lockedSet = await LearningSet.findOne({ slug: 'c1-set' })

    await LearningSession.create({
      student: freeStudent._id,
      learningSet: lockedSet._id,
      learningSetSlug: lockedSet.slug,
      theme: lockedSet.title,
      level: lockedSet.level,
      mode: 'static',
      status: 'in_progress',
      currentStep: 'lesson',
      targetWords: [{ word: 'revenue', partOfSpeech: 'noun', definitionVi: 'doanh thu' }],
    })

    const current = await auth(request(app).get('/api/sessions/current')).expect(200)
    expect(current.body.data).toBeNull()

    const resumed = await auth(request(app).post('/api/sessions/start'))
      .send({ learningSetSlug: 'c1-set' })
    expect(resumed.status).toBe(404)
  })

  it('allows Free accounts up to 3 garden waters per day and Plus accounts 8 per day', async () => {
    const LearningSession = mongoose.model('LearningSession')
    await LearningSession.create([
      {
        student: freeStudent._id,
        theme: 'Basics',
        level: 'A2',
        mode: 'static',
        status: 'completed',
        currentStep: 'completed',
        targetWords: [{ word: 'hello' }],
      },
      {
        student: plusStudent._id,
        theme: 'Basics',
        level: 'A2',
        mode: 'static',
        status: 'completed',
        currentStep: 'completed',
        targetWords: [{ word: 'hello' }],
      },
    ])

    await auth(request(app).get('/api/garden/status')).expect(200)
    for (let i = 0; i < 3; i += 1) {
      await auth(request(app).post('/api/garden/water')).send({ theme: 'Basics' }).expect(200)
    }
    await auth(request(app).post('/api/garden/water')).send({ theme: 'Basics' }).expect(429)

    await grantPlus()
    const paidRes = await auth(request(app).post('/api/garden/water'), otherToken)
      .send({ theme: 'Basics' })
      .expect(200)
    expect(paidRes.body.data.dailyLimit).toBe(8)
  })

  it('keeps standard SRS available to Free accounts', async () => {
    await auth(request(app).get('/api/srs/due')).expect(200)
  })
})

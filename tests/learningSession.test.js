import {
  beforeAll,
  afterAll,
  beforeEach,
  describe,
  it,
  expect,
  vi,
} from 'vitest'
import mongoose from 'mongoose'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import request from 'supertest'
import jwt from 'jsonwebtoken'
vi.mock('../src/services/vocabularyAnalysis.service.js', async (original) => {
  const real = await original()
  return { ...real, analyzeVocabulary: vi.fn() }
})
vi.mock('../src/services/ai.service.js', async (original) => {
  const real = await original()
  return { ...real, processEssayAnalysis: vi.fn().mockResolvedValue(undefined) }
})
import app from '../src/app.js'
import User from '../src/models/User.js'
import LearningSet from '../src/models/LearningSet.js'
import Vocabulary from '../src/models/Vocabulary.js'
import LearningSession from '../src/models/LearningSession.js'
import ReviewEvent from '../src/models/ReviewEvent.js'
import PracticeAttempt from '../src/models/PracticeAttempt.js'
import EssayRevision from '../src/models/EssayRevision.js'
import WordUsageEvidence from '../src/models/WordUsageEvidence.js'
import Class from '../src/models/Class.js'
import Essay from '../src/models/Essay.js'
import Assignment from '../src/models/Assignment.js'
import Subscription from '../src/models/Subscription.js'
import SubscriptionPlan from '../src/models/SubscriptionPlan.js'
import { learningSetCache } from '../src/services/learningCache.service.js'
import { analyzeVocabulary } from '../src/services/vocabularyAnalysis.service.js'
let mongo, student, stranger, teacher, token, otherToken, teacherToken, set
const auth = (r, t = token) => r.set('Authorization', 'Bearer ' + t)
const item = (word) => ({
  word,
  partOfSpeech: 'noun',
  definitionVi: 'nghĩa ' + word,
  quizQuestions: [
    {
      type: 'multiple-choice',
      question: 'Meaning?',
      options: ['yes', 'no'],
      correctAnswer: 'yes',
    },
  ],
})
beforeAll(async () => {
  process.env.JWT_SECRET = 'test-only-learning-secret'
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } })
  await mongoose.connect(mongo.getUri())
  await Promise.all(Object.values(mongoose.models).map((model) => model.init()))
}, 120000)
afterAll(async () => {
  await mongoose.disconnect()
  if (mongo) await mongo.stop()
}, 30000)
beforeEach(async () => {
  learningSetCache.clear()
  await Promise.all(
    Object.values(mongoose.models).map((model) => model.deleteMany({})),
  )
  student = await User.create({
    name: 'Student',
    email: 'student@example.test',
    password: 'password1',
  })
  stranger = await User.create({
    name: 'Other',
    email: 'other@example.test',
    password: 'password1',
  })
  teacher = await User.create({
    name: 'Teacher',
    email: 'teacher@example.test',
    password: 'password1',
    role: 'teacher',
  })
  token = jwt.sign({ id: student.id }, process.env.JWT_SECRET)
  otherToken = jwt.sign({ id: stranger.id }, process.env.JWT_SECRET)
  teacherToken = jwt.sign({ id: teacher.id }, process.env.JWT_SECRET)
  set = await LearningSet.create({
    slug: 'daily-life',
    title: 'Daily life',
    description: 'Daily',
    level: 'B1',
    category: 'Daily Life',
    status: 'published',
    items: [item('routine'), item('commute'), item('grocery')],
  })
  analyzeVocabulary.mockReset()
})

// The garden endpoint is a paid feature (PAY-02); grant Plus only to the tests
// that read it so the free-quota tests keep their Free tier.
const grantStudentPlus = async () => {
  const plan = await SubscriptionPlan.create({
    slug: 'student-plus-test',
    name: 'Student Plus',
    targetRole: 'student',
    tier: 'plus',
    monthlyPrice: 59000,
    yearlyPrice: 499000,
    dailyAiEssayLimit: 15,
    isActive: true,
  })
  await Subscription.create({
    user: student._id, plan: plan._id, planSlug: plan.slug, targetRole: 'student',
    tier: 'plus', billingCycle: 'monthly', amountPaid: 59000, orderCode: 9001,
    startDate: new Date(Date.now() - 86400000),
    endDate: new Date(Date.now() + 30 * 24 * 3600 * 1000),
  })
}
const start = () =>
  auth(request(app).post('/api/sessions/start')).send({
    learningSetSlug: 'daily-life',
  })
const toWriting = async () => {
  const session = (await start()).body.data
  await auth(request(app).put('/api/sessions/' + session._id + '/step'))
    .send({ currentStep: 'practice' })
    .expect(200)
  for (const w of session.targetWords)
    await auth(request(app).post('/api/practice/submit'))
      .set('Idempotency-Key', session._id + w.word)
      .send({
        sessionId: session._id,
        wordId: w.wordId,
        questionType: 'multiple_choice',
        answer: w.quizQuestions?.length ? 'yes' : w.definitionVi,
      })
      .expect(201)
  await auth(request(app).put('/api/sessions/' + session._id + '/step'))
    .send({ currentStep: 'writing' })
    .expect(200)
  return session
}
const goodAnalysis = (content, words) => ({
  summary: 'Good',
  strengths: [],
  priorities: [],
  lexicalSuggestions: [],
  targetWordResults: words.map((word) => ({
    word,
    found: true,
    matchedText: word,
    status: 'correct',
    issueType: null,
    explanationVi: 'Đúng',
    suggestedUpgrade: null,
    quoteVerified: true,
    start: content.indexOf(word),
    end: content.indexOf(word) + word.length,
  })),
})
describe('Learning API with real Mongo transactions and JWT', () => {
  it('rejects entering writing step when unpracticed even if autoRecordPractice: true is sent [ST-03]', async () => {
    const session = (await start()).body.data
    await auth(request(app).put(`/api/sessions/${session._id}/step`))
      .send({ currentStep: 'practice' }).expect(200)
    const res = await auth(request(app).put(`/api/sessions/${session._id}/step`))
      .send({ currentStep: 'writing', autoRecordPractice: true })
      .expect(409)
    expect(res.body.error || res.body.message).toContain('Practice every target word first')
    const attempts = await PracticeAttempt.find({ session: session._id }).lean()
    expect(attempts).toHaveLength(0)

    for (const w of session.targetWords) {
      await auth(request(app).post('/api/practice/submit'))
        .set('Idempotency-Key', session._id + w.word)
        .send({
          sessionId: session._id,
          wordId: w.wordId,
          questionType: 'multiple_choice',
          answer: w.quizQuestions?.length ? 'yes' : w.definitionVi,
        })
        .expect(201)
    }

    const okRes = await auth(request(app).put(`/api/sessions/${session._id}/step`))
      .send({ currentStep: 'writing' })
      .expect(200)
    expect(okRes.body.data.currentStep).toBe('writing')
  })
  it('previews new round words and starts exactly the previewed session', async () => {
    const first = await auth(request(app).get('/api/learning-sets/explore')).expect(200)
    const firstTopic = first.body.data.find(s => s.slug === 'daily-life')
    expect(firstTopic.targetWords.map(w => w.word)).toEqual(['routine', 'commute', 'grocery'])
    await LearningSession.create({ student: student._id, learningSet: set._id, learningSetSlug: set.slug,
      mode: 'static', status: 'completed', currentStep: 'completed', targetWords: firstTopic.targetWords })
    const next = await auth(request(app).get('/api/learning-sets/explore')).expect(200)
    const topic = next.body.data.find(s => s.slug === 'daily-life')
    expect(topic.round).toBe(2)
    expect(topic.targetWords.map(w => w.word)).toEqual(['schedule', 'errand', 'household'])
    const started = await start().expect(201)
    expect(started.body.data.targetWords).toEqual(topic.targetWords)
    const resumedPreview = await auth(request(app).get('/api/learning-sets/explore')).expect(200)
    expect(resumedPreview.body.data.find(s => s.slug === 'daily-life').targetWords).toEqual(started.body.data.targetWords)
  })
  it('persists analysis with standalone fallback and rejects unfinished receipts without a server crash', async () => {
    const session = await toWriting()
    const content = 'My daily routine includes a commute and grocery shopping. ' + Array(53).fill('word').join(' ')
    analyzeVocabulary.mockResolvedValue(goodAnalysis(content, session.targetWords.map(w => w.word)))
    const transaction = vi.spyOn(mongoose.connection, 'transaction').mockRejectedValue(
      Object.assign(new Error('Transaction numbers are only allowed on a replica set member or mongos'), { code: 20 }),
    )
    try {
      const submitted = await auth(request(app).post('/api/essays/submit-revision'))
        .send({ sessionId: session._id, content, requestId: 'standalone-first' }).expect(201)
      expect(submitted.body.data.analysisStatus).toBe('succeeded')
      const essayId = submitted.body.data.originalEssay
      const incorrectEndpoint = () => auth(request(app).post('/api/essays/submit-revision'))
        .send({ sessionId: session._id, content, requestId: 'standalone-invalid-correction' })
      await incorrectEndpoint().expect(409)
      const repeated = await incorrectEndpoint().expect(409)
      expect(repeated.body.error).toContain('Previous submission did not finish')
      const corrected = await auth(request(app).post(`/api/essays/${essayId}/revisions`))
        .send({ content, requestId: 'standalone-correction' }).expect(201)
      expect(corrected.body.data.revisionNumber).toBe(2)
      expect(corrected.body.data.analysisStatus).toBe('succeeded')
    } finally {
      transaction.mockRestore()
    }
  })
  it('protects all new endpoint families', async () => {
    for (const path of [
      '/api/profile/learning',
      '/api/sessions/current',
      '/api/srs/due',
      '/api/garden/status',
      '/api/progress/active-vocabulary',
    ]) {
      await request(app).get(path).expect(401)
    }
  })
  it('validates and persists profile without privilege escalation', async () => {
    await auth(request(app).put('/api/profile/learning'))
      .send({
        targetLevel: 'C1',
        dailyGoalMinutes: 15,
        interests: ['Travel'],
        onboardingCompleted: true,
        timezone: 'Asia/Ho_Chi_Minh',
      })
      .expect(200)
    const r = await auth(request(app).get('/api/profile/learning')).expect(200)
    expect(r.body.data.targetLevel).toBe('C1')
    await auth(request(app).put('/api/profile/learning'))
      .send({ role: 'admin' })
      .expect(400)
    await auth(request(app).put('/api/profile/learning'))
      .send({ timezone: 'Not/AZone' })
      .expect(400)
  })
  it('starts one active session even under concurrent requests and hides answers', async () => {
    const results = await Promise.all([start(), start(), start()])
    expect(results.every((r) => [200, 201].includes(r.status))).toBe(true)
    expect(new Set(results.map((r) => r.body.data._id)).size).toBe(1)
    expect(await LearningSession.countDocuments({ student: student.id })).toBe(
      1,
    )
    expect(JSON.stringify(results[0].body)).not.toContain('correctAnswer')
  })
  it('rejects other students and skipped steps', async () => {
    const r = await start()
    const id = r.body.data._id
    await auth(request(app).put('/api/sessions/' + id + '/step'), otherToken)
      .send({ currentStep: 'practice' })
      .expect(404)
    await auth(request(app).put('/api/sessions/' + id + '/step'))
      .send({ currentStep: 'completed', status: 'completed' })
      .expect(409)
    await auth(request(app).put('/api/sessions/' + id + '/step'))
      .send({ currentStep: 'practice' })
      .expect(200)
  })
  it('grades from snapshot and deduplicates practice intents', async () => {
    const r = await start(),
      session = r.body.data
    await auth(request(app).put('/api/sessions/' + session._id + '/step'))
      .send({ currentStep: 'practice' })
      .expect(200)
    const body = {
      sessionId: session._id,
      wordId: session.targetWords[0].wordId,
      questionType: 'multiple_choice',
      answer: 'no',
      isCorrect: true,
    }
    const send = () =>
      auth(request(app).post('/api/practice/submit'))
        .set('Idempotency-Key', 'practice-one')
        .send(body)
    const first = await send().expect(201)
    expect(first.body.data.isCorrect).toBe(false)
    await send().expect(200)
    expect(await PracticeAttempt.countDocuments()).toBe(1)
    await auth(request(app).post('/api/practice/submit'))
      .set('Idempotency-Key', 'practice-one')
      .send({ ...body, answer: 'yes' })
      .expect(409)
  })
  it('atomically reviews, records events and prevents duplicate requests', async () => {
    const word = await Vocabulary.create({
      student: student.id,
      word: 'routine',
    })
    const send = () =>
      auth(request(app).post('/api/srs/review'))
        .set('Idempotency-Key', 'review-one')
        .send({ vocabularyId: word.id, rating: 3 })
    const rr = await Promise.all([send(), send()])
    expect(rr.every((r) => r.status === 200)).toBe(true)
    expect((await Vocabulary.findById(word.id)).reviewCount).toBe(1)
    expect(await ReviewEvent.countDocuments()).toBe(1)
    await auth(request(app).post('/api/srs/review'), otherToken)
      .set('Idempotency-Key', 'other')
      .send({ vocabularyId: word.id, rating: 3 })
      .expect(404)
    await auth(request(app).post('/api/srs/review'))
      .set('Idempotency-Key', 'review-one')
      .send({ vocabularyId: word.id, rating: 1 })
      .expect(409)
  })
  it('runs practice → writing → revision → evidence → completion without repeat AI charges', async () => {
    const session = (await start()).body.data
    await auth(request(app).put('/api/sessions/' + session._id + '/step'))
      .send({ currentStep: 'practice' })
      .expect(200)
    for (const w of session.targetWords) {
      await auth(request(app).post('/api/practice/submit'))
        .set('Idempotency-Key', w.word)
        .send({
          sessionId: session._id,
          wordId: w.wordId,
          questionType: 'multiple_choice',
          answer: 'yes',
        })
        .expect(201)
    }
    await auth(request(app).put('/api/sessions/' + session._id + '/step'))
      .send({ currentStep: 'writing' })
      .expect(200)
    const content =
      'My daily routine includes a commute and grocery shopping. ' +
      Array(53).fill('word').join(' ')
    analyzeVocabulary.mockResolvedValue({
      summary: 'Good',
      strengths: [],
      priorities: [],
      lexicalSuggestions: [],
      targetWordResults: session.targetWords.map((w) => ({
        word: w.word,
        found: true,
        matchedText: w.word,
        status: 'correct',
        issueType: null,
        explanationVi: 'Đúng',
        suggestedUpgrade: null,
        quoteVerified: true,
        start: content.indexOf(w.word),
        end: content.indexOf(w.word) + w.word.length,
      })),
    })
    const send = () =>
      auth(request(app).post('/api/essays/submit-revision'))
        .set('Idempotency-Key', 'essay-one')
        .send({
          sessionId: session._id,
          content,
          targetWords: session.targetWords.map((w) => w.word),
        })
    const first = await send().expect(201)
    await send().expect(200)
    expect(analyzeVocabulary).toHaveBeenCalledTimes(1)
    expect(await EssayRevision.countDocuments()).toBe(1)
    expect(await WordUsageEvidence.countDocuments()).toBe(3)
    const essayId = first.body.data.originalEssay
    await auth(
      request(app).post('/api/essays/' + essayId + '/revisions'),
      otherToken,
    )
      .set('Idempotency-Key', 'steal')
      .send({ content })
      .expect(404)
    await auth(request(app).put('/api/sessions/' + session._id + '/step'))
      .send({ currentStep: 'completed' })
      .expect(200)
    const rounds = await auth(request(app).get('/api/sessions/round-counts')).expect(200)
    expect(rounds.body.data.counts['daily-life']).toBe(1)
    await auth(request(app).put('/api/sessions/' + session._id + '/step'))
      .send({ currentStep: 'completed' }).expect(200)
    const repeated = await auth(request(app).get('/api/sessions/round-counts')).expect(200)
    expect(repeated.body.data.counts['daily-life']).toBe(1)
    await request(app).get('/api/sessions/round-counts').expect(401)
    await auth(request(app).get('/api/sessions/round-counts'), teacherToken).expect(403)
    const secondSession = await toWriting()
    const secondContent = secondSession.targetWords.map(w => w.word).join(' ') + ' ' + Array(60).fill('word').join(' ')
    analyzeVocabulary.mockResolvedValue(goodAnalysis(secondContent, secondSession.targetWords.map(w => w.word)))
    const beforeCompletion = await auth(request(app).get('/api/sessions/round-counts')).expect(200)
    expect(beforeCompletion.body.data.counts['daily-life']).toBe(1)
    await auth(request(app).post('/api/essays/submit-revision'))
      .send({ sessionId: secondSession._id, content: secondContent,
        targetWords: secondSession.targetWords.map(w => w.word), requestId: 'essay-two' }).expect(201)
    await auth(request(app).put('/api/sessions/' + secondSession._id + '/step'))
      .send({ currentStep: 'completed' }).expect(200)
    const secondRound = await auth(request(app).get('/api/sessions/round-counts')).expect(200)
    expect(secondRound.body.data.counts['daily-life']).toBe(2)
    const progress = await auth(
      request(app).get('/api/progress/active-vocabulary'),
    ).expect(200)
    expect(progress.body.data.masteredCount).toBe(0)
  })
  it('saves practice for a legacy word without authored quiz questions and unlocks writing', async () => {
    set.items = [{ ...item('grocery'), quizQuestions: [] }]
    await set.save()
    const session = (await start()).body.data
    await auth(request(app).put('/api/sessions/' + session._id + '/step'))
      .send({ currentStep: 'practice' }).expect(200)
    await auth(request(app).put('/api/sessions/' + session._id + '/step'))
      .send({ currentStep: 'writing' }).expect(409)
    const answer = await auth(request(app).post('/api/practice/submit'))
      .send({ sessionId: session._id, wordId: session.targetWords[0].wordId,
        questionType: 'multiple_choice', questionIndex: 0, answer: 'nghĩa grocery', requestId: 'legacy-grocery' }).expect(201)
    expect(answer.body.data.isCorrect).toBe(true)
    for (const w of session.targetWords.slice(1)) {
      await auth(request(app).post('/api/practice/submit'))
        .send({ sessionId: session._id, wordId: w.wordId, questionType: 'multiple_choice',
          answer: w.definitionVi, requestId: 'legacy-' + w.word }).expect(201)
    }
    await auth(request(app).put('/api/sessions/' + session._id + '/step'))
      .send({ currentStep: 'writing' }).expect(200)
  })
  it('grades cached AI practice from the server snapshot and replays retries', async () => {
    const session = (await start()).body.data
    await auth(request(app).put('/api/sessions/' + session._id + '/step'))
      .send({ currentStep: 'practice' }).expect(200)
    await LearningSession.updateOne({ _id: session._id }, { $set: { practiceQuestions: [{
      id: 'ai-test', word: session.targetWords[0].word, type: 'multiple_choice',
      options: ['correct', 'wrong'], correctAnswer: 'correct',
    }] } })
    const payload = { sessionId: session._id, wordId: session.targetWords[0].wordId,
      questionId: 'ai-test', questionType: 'multiple_choice', answer: 'wrong', requestId: 'ai-answer' }
    const first = await auth(request(app).post('/api/practice/submit')).send(payload).expect(201)
    expect(first.body.data.isCorrect).toBe(false)
    expect(first.body.data.correctAnswer).toBe('correct')
    const retry = await auth(request(app).post('/api/practice/submit')).send(payload).expect(200)
    expect(retry.body.data._id).toBe(first.body.data._id)
    await auth(request(app).post('/api/practice/submit'))
      .send({ ...payload, questionId: 'unknown', requestId: 'unknown-ai' }).expect(404)
  })
  it('[LEARN-15] allows submitting practice answer with uppercase/punctuated question word and auto-resolves wordId if missing', async () => {
    const session = (await start()).body.data
    await auth(request(app).put('/api/sessions/' + session._id + '/step'))
      .send({ currentStep: 'practice' }).expect(200)
    await LearningSession.updateOne({ _id: session._id }, { $set: { practiceQuestions: [{
      id: 'ai-learn15-test', word: 'GROCERY!', type: 'multiple_choice',
      options: ['correct', 'wrong'], correctAnswer: 'correct', explanation: 'Groceries meaning'
    }] } })
    const groceryWord = session.targetWords.find(w => w.word === 'grocery')
    // 1. Submit with wordId where question word in session is uppercase 'GROCERY!'
    const payload1 = {
      sessionId: session._id,
      wordId: groceryWord.wordId,
      questionId: 'ai-learn15-test',
      questionType: 'multiple_choice',
      answer: 'correct',
      requestId: 'ai-learn15-req-1'
    }
    const res1 = await auth(request(app).post('/api/practice/submit')).send(payload1).expect(201)
    expect(res1.body.data.isCorrect).toBe(true)

    // 2. Submit without wordId (or empty) but with questionId - backend resolves wordId automatically
    const payload2 = {
      sessionId: session._id,
      wordId: '',
      questionId: 'ai-learn15-test',
      questionType: 'multiple_choice',
      answer: 'correct',
      requestId: 'ai-learn15-req-2'
    }
    const res2 = await auth(request(app).post('/api/practice/submit')).send(payload2).expect(201)
    expect(res2.body.data.isCorrect).toBe(true)
    expect(res2.body.data.wordId).toBe(groceryWord.wordId)
  })
  it('never returns another teacher class lexical data', async () => {
    const cls = await Class.create({
      name: 'Class',
      teacher: teacher.id,
      students: [student.id],
    })
    await auth(
      request(app).get('/api/teacher/classes/' + cls.id + '/lexical-errors'),
    ).expect(403)
    const r = await auth(
      request(app).get('/api/teacher/classes/' + cls.id + '/lexical-errors'),
      teacherToken,
    ).expect(200)
    expect(r.body.data).toEqual([])
  })
  it('counts mastery only for two independent essays and days, not assisted corrections', async () => {
    const word = await Vocabulary.create({
      student: student.id,
      word: 'routine',
      reviewInterval: 8,
      reviewCount: 2,
    })
    const make = (overrides) => ({
      student: student.id,
      word: 'routine',
      meaning: 'habit',
      contextSentence: 'A',
      essayId: new mongoose.Types.ObjectId(),
      revisionId: new mongoose.Types.ObjectId(),
      isVerifiedCorrect: true,
      assisted: false,
      localDay: '2026-09-07',
      theme: 'Daily Life',
      ...overrides,
    })
    await WordUsageEvidence.create([
      make({}),
      make({ contextSentence: 'B', localDay: '2026-09-08', assisted: true }),
    ])
    let r = await auth(request(app).get('/api/progress/active-vocabulary'))
    expect(r.body.data).toEqual({
      savedCount: 1,
      retainedCount: 1,
      masteredCount: 0,
    })
    await WordUsageEvidence.create(
      make({ contextSentence: 'C', localDay: '2026-09-08' }),
    )
    r = await auth(request(app).get('/api/progress/active-vocabulary'))
    expect(r.body.data.masteredCount).toBe(1)
    await grantStudentPlus()
    const g = await auth(request(app).get('/api/garden/status')).expect(200)
    expect(g.body.data).toEqual([
      {
        theme: 'Daily Life',
        slug: null,
        learningSetSlug: null,
        totalCount: 0,
        masteredCount: 1,
        stage: 'sprout',
        words: [{ word: 'routine', status: 'mastered', evidence: 'C' }],
      },
    ])
    const other = await auth(
      request(app).get('/api/progress/evidence/routine'),
      otherToken,
    ).expect(200)
    expect(other.body.data).toEqual([])
    expect(word.id).toBeTruthy()
  })
  it('does not count same-day essays or different meanings as mastery', async () => {
    const make = (meaning, day) => ({
      student: student.id,
      word: 'routine',
      meaning,
      contextSentence: meaning + day,
      essayId: new mongoose.Types.ObjectId(),
      revisionId: new mongoose.Types.ObjectId(),
      isVerifiedCorrect: true,
      localDay: day,
    })
    await WordUsageEvidence.create([
      make('habit', '2026-09-08'),
      make('performance', '2026-09-09'),
    ])
    expect(
      (await auth(request(app).get('/api/progress/active-vocabulary'))).body
        .data.masteredCount,
    ).toBe(0)
  })
  it('blocks smart-writing AI analysis when the student has used the daily free quota', async () => {
    const session = await toWriting()
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    await Essay.create(Array.from({ length: 3 }, (_, i) => ({
      student: student._id,
      title: `Previously graded ${i + 1}`,
      content: 'Previously graded essay content',
      status: 'reviewed',
      submittedAt: new Date(today.getTime() + i * 60_000),
    })))
    const content = 'My routine involves a commute and grocery shopping. ' + Array(54).fill('word').join(' ')
    const send = () => auth(request(app).post('/api/essays/submit-revision'))
      .set('Idempotency-Key', 'free-limit')
      .send({ sessionId: session._id, content })
    await send().expect(429).expect(({ body }) => {
      expect(['DAILY_AI_QUOTA_EXCEEDED', 'DAILY_ESSAY_LIMIT_REACHED']).toContain(body.code)
      expect(body.errorCode).toBe('DAILY_ESSAY_LIMIT_REACHED')
      expect(body.error).toContain('Daily AI essay limit reached (3)')
    })
    await send().expect(429).expect(({ body }) => {
      expect(['DAILY_AI_QUOTA_EXCEEDED', 'DAILY_ESSAY_LIMIT_REACHED']).toContain(body.code)
      expect(body.errorCode).toBe('DAILY_ESSAY_LIMIT_REACHED')
    })
    expect(await EssayRevision.countDocuments()).toBe(0)
    expect(analyzeVocabulary).not.toHaveBeenCalled()
  })

  it('blocks smart-writing AI review without leaving a pending idempotency operation', async () => {
    const session = await toWriting()
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    await Essay.create(Array.from({ length: 3 }, (_, i) => ({
      student: student._id,
      title: `Previously graded ${i + 1}`,
      content: 'Previously graded essay content',
      status: 'reviewed',
      submittedAt: new Date(today.getTime() + i * 60_000),
    })))
    const content = 'My routine involves a commute and grocery shopping. ' + Array(54).fill('word').join(' ')
    await auth(request(app).post('/api/essays/submit-revision'))
      .set('Idempotency-Key', 'free-limit-retry')
      .send({ sessionId: session._id, content })
      .expect(429)
    expect(await EssayRevision.countDocuments()).toBe(0)
    const { default: LearningOperation } = await import('../src/models/LearningOperation.js')
    expect(await LearningOperation.countDocuments({ student: student._id, scope: 'revision', key: 'free-limit-retry' })).toBe(0)
  })

  it('does not charge daily AI essay quota again for an idempotent smart-writing replay', async () => {
    const session = await toWriting()
    const content = 'My routine involves a commute and grocery shopping. ' + Array(54).fill('word').join(' ')
    analyzeVocabulary.mockResolvedValue(goodAnalysis(content, session.targetWords.map((w) => w.word)))
    const aiService = await import('../src/services/ai.service.js')
    const analysisCallCountBefore = aiService.processEssayAnalysis.mock.calls.length
    const send = () => auth(request(app).post('/api/essays/submit-revision'))
      .set('Idempotency-Key', 'same-successful-request')
      .send({ sessionId: session._id, content })
    await send().expect(201)
    expect(aiService.processEssayAnalysis).toHaveBeenCalledTimes(analysisCallCountBefore + 1)
    await Essay.create(Array.from({ length: 3 }, (_, i) => ({
      student: student._id,
      title: `Later submission ${i + 1}`,
      content: 'A later reviewed essay',
      status: 'reviewed',
      submittedAt: new Date(),
    })))
    const replay = await send().expect(200)
    expect(replay.body.success).toBe(true)
    expect(await EssayRevision.countDocuments()).toBe(1)
    expect(aiService.processEssayAnalysis).toHaveBeenCalledTimes(analysisCallCountBefore + 1)
  })

  it('stores failed revisions and retries the same snapshot without a second revision', async () => {
    const session = await toWriting()
    const content =
      'My routine involves a commute and grocery shopping. ' +
      Array(54).fill('word').join(' ')
    const body = { sessionId: session._id, content }
    analyzeVocabulary.mockRejectedValueOnce(
      Object.assign(new Error('Provider unavailable'), { statusCode: 502 }),
    )
    const r = await auth(request(app).post('/api/essays/submit-revision'))
      .set('Idempotency-Key', 'retry-me')
      .send(body)
      .expect(502)
    expect(await EssayRevision.countDocuments()).toBe(1)
    expect(await WordUsageEvidence.countDocuments()).toBe(0)
    analyzeVocabulary.mockResolvedValue(
      goodAnalysis(
        content,
        session.targetWords.map((w) => w.word),
      ),
    )
    await auth(request(app).post(r.body.retryUrl)).expect(200)
    await auth(request(app).post(r.body.retryUrl)).expect(200)
    expect(analyzeVocabulary).toHaveBeenCalledTimes(2)
    expect(await EssayRevision.countDocuments()).toBe(1)
  })
  it('marks corrections assisted and preserves original content', async () => {
    const session = await toWriting()
    const content =
      'My routine involves a commute and grocery shopping. ' +
      Array(54).fill('word').join(' ')
    analyzeVocabulary.mockResolvedValue(
      goodAnalysis(
        content,
        session.targetWords.map((w) => w.word),
      ),
    )
    const first = await auth(request(app).post('/api/essays/submit-revision'))
      .set('Idempotency-Key', 'first')
      .send({ sessionId: session._id, content })
      .expect(201)
    const correction = content.replace('My routine', 'Our routine')
    analyzeVocabulary.mockResolvedValue(
      goodAnalysis(
        correction,
        session.targetWords.map((w) => w.word),
      ),
    )
    const second = await auth(
      request(app).post(
        '/api/essays/' + first.body.data.originalEssay + '/revisions',
      ),
    )
      .set('Idempotency-Key', 'second')
      .send({ content: correction })
      .expect(201)
    expect(second.body.data.assisted).toBe(true)
    expect((await EssayRevision.findById(first.body.data._id)).content).toBe(
      content,
    )
    expect(second.body.data.revisionNumber).toBe(2)
  })
  it('does not disclose question answers in learning set APIs', async () => {
    const r = await auth(
      request(app).get('/api/learning-sets/daily-life'),
    ).expect(200)
    expect(JSON.stringify(r.body)).not.toContain('correctAnswer')
    await auth(request(app).get('/api/learning-sets?category[$ne]=x')).expect(
      400,
    )
  })
  it('validates missing keys and immutable target words', async () => {
    const session = await toWriting()
    const content =
      'My routine involves a commute and grocery shopping. ' +
      Array(54).fill('word').join(' ')
    await auth(request(app).post('/api/essays/submit-revision'))
      .send({ sessionId: session._id, content })
      .expect(400)
    await auth(request(app).post('/api/essays/submit-revision'))
      .set('Idempotency-Key', 'bad-targets')
      .send({ sessionId: session._id, content, targetWords: ['fake'] })
      .expect(400)
    expect(analyzeVocabulary).not.toHaveBeenCalled()
  })
  it('teacher assignments link published sets and validate enrollment', async () => {
    const cls = await Class.create({
      name: 'Class',
      teacher: teacher.id,
      students: [student.id],
    })
    const a = await auth(request(app).post('/api/assignments'), teacherToken)
      .send({
        title: 'Practice',
        classId: cls.id,
        dueDate: new Date(Date.now() + 86400000).toISOString(),
        learningSetId: set.id,
      })
      .expect(201)
    expect(a.body.data.learningSetId).toBe(set.id)
    await auth(request(app).post('/api/sessions/start'), otherToken)
      .send({ assignmentId: a.body.data._id })
      .expect(404)
    const s = await auth(request(app).post('/api/sessions/start'))
      .send({ assignmentId: a.body.data._id })
      .expect(201)
    expect(s.body.data.assignment).toBe(a.body.data._id)
  })

  it('[ST-04] does not reuse an existing generic in_progress session when starting a session for an assignment', async () => {
    const cls = await Class.create({
      name: 'Class ST04',
      teacher: teacher.id,
      students: [student.id],
    })
    const a = await auth(request(app).post('/api/assignments'), teacherToken)
      .send({
        title: 'Assignment ST-04',
        classId: cls.id,
        dueDate: new Date(Date.now() + 86400000).toISOString(),
        learningSetId: set.id,
      })
      .expect(201)

    // 1. Student starts a generic session (no assignment)
    const genericSession = await auth(request(app).post('/api/sessions/start'))
      .send({ learningSetSlug: set.slug })
      .expect(201)
    expect(genericSession.body.data.assignment).toBeNull()

    // 2. Student starts a session with assignmentId
    // Must NOT reuse genericSession; must return a new session linked to assignment
    const assignSession = await auth(request(app).post('/api/sessions/start'))
      .send({ assignmentId: a.body.data._id })
      .expect(201)
    expect(assignSession.body.data._id).not.toBe(genericSession.body.data._id)
    expect(assignSession.body.data.assignment).toBe(a.body.data._id)

    // Verify the previous generic session was marked abandoned
    const old = await LearningSession.findById(genericSession.body.data._id)
    expect(old.status).toBe('abandoned')
  })
  it('aggregates latest revision errors only within the teacher class', async () => {
    const cls = await Class.create({
      name: 'Class',
      teacher: teacher.id,
      students: [student.id],
    })
    const essay = await Essay.create({
      student: student.id,
      title: 'Essay',
      class: cls.id,
    })
    const base = {
      student: student.id,
      originalEssay: essay.id,
      session: new mongoose.Types.ObjectId(),
      content: 'Test',
      contentHash: 'test',
      wordCount: 1,
      targetWords: ['routine'],
      analysisStatus: 'succeeded',
    }
    await EssayRevision.create([
      {
        ...base,
        revisionNumber: 1,
        targetWordResults: [
          { word: 'routine', status: 'incorrect', issueType: 'collocation' },
        ],
      },
      {
        ...base,
        revisionNumber: 2,
        targetWordResults: [
          { word: 'routine', status: 'correct', issueType: null },
        ],
      },
    ])
    const r = await auth(
      request(app).get('/api/teacher/classes/' + cls.id + '/lexical-errors'),
      teacherToken,
    ).expect(200)
    expect(r.body.data).toEqual([])
    await EssayRevision.create({
      ...base,
      revisionNumber: 3,
      targetWordResults: [
        {
          word: 'routine',
          status: 'needs_improvement',
          issueType: 'word_form',
        },
      ],
    })
    const r2 = await auth(
      request(app).get('/api/teacher/classes/' + cls.id + '/lexical-errors'),
      teacherToken,
    ).expect(200)
    expect(r2.body.data).toEqual([
      { word: 'routine', issueType: 'word_form', count: 1 },
    ])
  })
  it('rejects suspended accounts', async () => {
    await User.updateOne(
      { _id: student.id },
      { $set: { accountStatus: 'suspended' } },
    )
    await auth(request(app).get('/api/sessions/current')).expect(403)
  })
  it('enforces 3 trial sessions in 24h for free tier users and reports status via trial-status', async () => {
    const statusRes0 = await auth(request(app).get('/api/sessions/trial-status')).expect(200)
    expect(statusRes0.body.data.isPaid).toBe(false)
    expect(statusRes0.body.data.used).toBe(0)
    expect(statusRes0.body.data.limit).toBe(3)
    expect(statusRes0.body.data.remaining).toBe(3)
    expect(statusRes0.body.data.allowed).toBe(true)

    await LearningSet.create({
      slug: 'set-2',
      title: 'Set 2',
      description: 'Set 2 description',
      level: 'B1',
      category: 'General',
      status: 'published',
      items: [item('wordtwo')],
    })
    await LearningSet.create({
      slug: 'set-3',
      title: 'Set 3',
      description: 'Set 3 description',
      level: 'B1',
      category: 'General',
      status: 'published',
      items: [item('wordthree')],
    })
    await LearningSet.create({
      slug: 'set-4',
      title: 'Set 4',
      description: 'Set 4 description',
      level: 'B1',
      category: 'General',
      status: 'published',
      items: [item('wordfour')],
    })

    await auth(request(app).post('/api/sessions/start')).send({ learningSetSlug: 'daily-life' }).expect(201)
    await auth(request(app).post('/api/sessions/start')).send({ learningSetSlug: 'set-2' }).expect(201)
    await auth(request(app).post('/api/sessions/start')).send({ learningSetSlug: 'set-3' }).expect(201)

    const statusRes3 = await auth(request(app).get('/api/sessions/trial-status')).expect(200)
    expect(statusRes3.body.data.used).toBe(3)
    expect(statusRes3.body.data.remaining).toBe(0)
    expect(statusRes3.body.data.allowed).toBe(false)

    const blockedRes = await auth(request(app).post('/api/sessions/start'))
      .send({ learningSetSlug: 'set-4' })
      .expect(403)
    expect(blockedRes.body.error || blockedRes.body.message).toContain('3 lượt học thử')
  })
})

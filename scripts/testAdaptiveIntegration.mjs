/**
 * Giai đoạn 3 — Integration test: startLearningSession với mode=adaptive
 *
 * Verify end-to-end controller:
 *  - mode='adaptive' → gọi buildAdaptiveSession, lưu mode + adaptiveReason
 *  - mode='static' (regression) → vẫn lấy từ LearningSet như cũ
 *  - wordId có prefix 'adaptive:'
 *  - DB persist đúng các field mới
 *  - Empty student → 404
 *
 * Chạy: cd server && node scripts/testAdaptiveIntegration.mjs
 * Yêu cầu: MongoDB đang chạy (cùng .env như app)
 */

import mongoose from 'mongoose'
import 'dotenv/config'
import { requireIsolatedTestExecution } from './localTestDatabaseGuard.js'

const { url: isolatedUrl } = requireIsolatedTestExecution('testAdaptiveIntegration', {
  envFlag: 'RUN_TEST_ADAPTIVE_INTEGRATION',
})

// Patch: standalone MongoDB không hỗ trợ transaction với replica set features.
// Test chạy với standalone → wrap transaction thành session đơn lẻ.
// Production code (replica set) sẽ tự chạy transaction thật.
const _origTransaction = mongoose.connection.transaction.bind(mongoose.connection)
mongoose.connection.transaction = async function (fn) {
  // Bypass: chỉ gọi fn() mà không truyền session — adapter test sẽ chạy without session
  // Controller có thể gặp vấn đề nếu strict về session trong options, nhưng standalone OK.
  return await fn(null)
}

import { startLearningSession } from '../src/controllers/learningSession.controller.js'
import LearningSession from '../src/models/LearningSession.js'
import LearningSet from '../src/models/LearningSet.js'
import Vocabulary from '../src/models/Vocabulary.js'
import PracticeAttempt from '../src/models/PracticeAttempt.js'
import User from '../src/models/User.js'

const MONGODB_URI = isolatedUrl.toString()

let pass = 0
let fail = 0
const log = (ok, name, info = '') => {
  const tag = ok ? '✅ PASS' : '❌ FAIL'
  console.log(`${tag}  ${name}${info ? ' — ' + info : ''}`)
  ok ? pass++ : fail++
}

/**
 * Mock Express req/res để gọi trực tiếp controller không cần HTTP server.
 */
function mockReqRes({ user, body = {} } = {}) {
  const req = { user, body }
  const res = {
    statusCode: 200,
    body: null,
    status(c) { this.statusCode = c; return this },
    json(payload) { this.body = payload; return this },
  }
  return { req, res }
}

async function seedStudent() {
  // Tạo user thật trong DB để pass qua middleware auth (controller chỉ cần req.user._id)
  const user = await User.create({
    name: 'Adaptive Test',
    email: `adaptive-test-${Date.now()}@test.local`,
    password: 'TestPassword123!', // schema yêu cầu password ≥6 ký tự
    role: 'student',
    learningProfile: { targetLevel: 'B1', interests: [] },
  })

  const studentId = user._id

  // Seed vocabulary cho adaptive
  await Vocabulary.insertMany([
    {
      student: studentId,
      word: 'apple',
      theme: 'Food',
      masteryLevel: 'learning',
      nextReviewDate: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
    },
    {
      student: studentId,
      word: 'banana',
      theme: 'Food',
      masteryLevel: 'new',
      nextReviewDate: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000),
    },
    {
      student: studentId,
      word: 'cherry',
      theme: 'Food',
      masteryLevel: 'learning',
      nextReviewDate: null,
    },
    {
      student: studentId,
      word: 'diligent',
      theme: 'Character',
      masteryLevel: 'learning',
      reviewCount: 2,
    },
    {
      student: studentId,
      word: 'eclipse',
      theme: 'Science',
      masteryLevel: 'new',
    },
    {
      student: studentId,
      word: 'happy',
      theme: 'Emotion',
      masteryLevel: 'mastered',
      reviewCount: 5,
      easeFactor: 2.8,
    },
  ])

  return user
}

async function seedPublishedLearningSet() {
  return await LearningSet.create({
    slug: `test-set-${Date.now()}`,
    title: 'Test Set',
    description: 'A test set for regression testing',
    category: 'Test',
    level: 'B1',
    status: 'published',
    items: [
      { word: 'static1', definitionVi: 'def1', partOfSpeech: 'n', phonetic: '', exampleSentences: [] },
      { word: 'static2', definitionVi: 'def2', partOfSpeech: 'v', phonetic: '', exampleSentences: [] },
      { word: 'static3', definitionVi: 'def3', partOfSpeech: 'adj', phonetic: '', exampleSentences: [] },
      { word: 'static4', definitionVi: 'def4', partOfSpeech: 'n', phonetic: '', exampleSentences: [] },
      { word: 'static5', definitionVi: 'def5', partOfSpeech: 'v', phonetic: '', exampleSentences: [] },
    ],
  })
}

async function teardown(user) {
  if (user) {
    await LearningSession.deleteMany({ student: user._id })
    await Vocabulary.deleteMany({ student: user._id })
    await PracticeAttempt.deleteMany({ student: user._id })
    await User.deleteOne({ _id: user._id })
  }
  // Xoá learning set test
  await LearningSet.deleteMany({ slug: { $regex: /^test-set-/ } })
}

async function run() {
  console.log('===== Giai đoạn 3: Adaptive Controller Integration Test =====\n')
  await mongoose.connect(MONGODB_URI)
  console.log('→ Connected to', MONGODB_URI)

  let user1, user2, user3
  let testSet

  try {
    // ========== TEST 1: Adaptive mode — happy path ==========
    console.log('\n--- TEST 1: Adaptive mode end-to-end ---')
    user1 = await seedStudent()
    const { req, res } = mockReqRes({ user: user1, body: { mode: 'adaptive' } })
    await startLearningSession(req, res)

    const created = await LearningSession.findOne({ student: user1._id })

    log(res.statusCode === 201, 'HTTP 201 Created', `got ${res.statusCode}`)
    log(!!created, 'Session được tạo trong DB')
    log(created?.mode === 'adaptive', 'mode = "adaptive"')
    log(
      created?.adaptiveReason?.match(/due-\d+,weak-\d+,new-\d+,lib-\d+/),
      'adaptiveReason khớp format "due-X,weak-Y,new-Z,lib-W"',
      `got "${created?.adaptiveReason}"`,
    )
    log(created?.learningSet === null, 'learningSet = null')
    log(created?.targetWords?.length === 5, 'targetWords.length = 5')
    log(
      created?.targetWords.every((w) => w.wordId?.startsWith('adaptive:')),
      'mọi wordId có prefix "adaptive:"',
      `sample: ${created?.targetWords[0]?.wordId}`,
    )
    log(
      created?.targetWords.every((w) => ['due', 'weak', 'new', 'lib'].includes(w.category)),
      'mỗi từ có category hợp lệ',
    )
    log(
      created?.targetWords.every((w) => w.reason && w.reason.length > 0),
      'mỗi từ có reason giải thích',
      `sample: "${created?.targetWords[0]?.reason}"`,
    )
    log(
      created?.assignment === null || created?.assignment === undefined,
      'assignment = null (adaptive không dùng assignment)',
    )
    log(
      created?.theme === 'Adaptive',
      'theme = "Adaptive"',
    )

    // Verify breakdown khớp với số từ thực tế
    const breakdown = created?.adaptiveReason?.match(/due-(\d+),weak-(\d+),new-(\d+),lib-(\d+)/)?.slice(1).map(Number)
    const due = created?.targetWords.filter((w) => w.category === 'due').length
    const weak = created?.targetWords.filter((w) => w.category === 'weak').length
    const nu = created?.targetWords.filter((w) => w.category === 'new').length
    const lib = created?.targetWords.filter((w) => w.category === 'lib').length
    const actual = [due, weak, nu, lib]
    log(
      JSON.stringify(breakdown) === JSON.stringify(actual),
      'breakdown trong reason khớp tổng từ thực tế',
      `declared=${JSON.stringify(breakdown)} actual=${JSON.stringify(actual)}`,
    )

    // ========== TEST 2: Adaptive mode — idempotent / tiếp tục session cũ ==========
    console.log('\n--- TEST 2: Gọi lại adaptive khi đã có session in_progress ---')
    const { req: req2, res: res2 } = mockReqRes({ user: user1, body: { mode: 'adaptive' } })
    await startLearningSession(req2, res2)

    const sessions = await LearningSession.find({ student: user1._id })
    log(
      sessions.length === 1,
      'Không tạo session mới — trả về session cũ (idempotent)',
      `total sessions: ${sessions.length}`,
    )
    log(
      res2.body?.message?.includes('Continue'),
      'Trả message "Continue your current learning session"',
    )

    // ========== TEST 3: Static mode — regression ==========
    console.log('\n--- TEST 3: Static mode (regression) ---')
    user2 = await seedStudent()
    testSet = await seedPublishedLearningSet()
    const { req: req3, res: res3 } = mockReqRes({
      user: user2,
      body: { learningSetSlug: testSet.slug },
    })
    await startLearningSession(req3, res3)

    const staticSession = await LearningSession.findOne({ student: user2._id })
    log(res3.statusCode === 201, 'Static HTTP 201')
    log(staticSession?.mode === 'static', 'mode = "static" (mặc định)')
    log(staticSession?.adaptiveReason === null, 'adaptiveReason = null')
    log(staticSession?.learningSet?.toString() === testSet._id.toString(), 'learningSet được set')
    log(staticSession?.learningSetSlug === testSet.slug, 'learningSetSlug đúng')
    log(
      staticSession?.targetWords.every((w) => !w.wordId.startsWith('adaptive:')),
      'wordId KHÔNG có prefix "adaptive:" (regression)',
      `sample: ${staticSession?.targetWords[0]?.wordId}`,
    )
    log(staticSession?.targetWords?.length === 5, '5 từ từ LearningSet')

    // Verify Vocabulary được upsert với masteryLevel='new'
    const newVocab = await Vocabulary.findOne({
      student: user2._id,
      word: 'static1',
    })
    log(!!newVocab, 'Vocabulary "static1" được upsert từ LearningSet')
    log(newVocab?.masteryLevel === 'new', 'masteryLevel = "new"')

    // ========== TEST 4: Adaptive mode — empty student ==========
    console.log('\n--- TEST 4: Adaptive với student chưa có vocabulary ---')
    user3 = await User.create({
      name: 'Empty User',
      email: `empty-${Date.now()}@test.local`,
      password: 'TestPassword123!',
      role: 'student',
      learningProfile: { targetLevel: 'B1' },
    })
    const { req: req4, res: res4 } = mockReqRes({ user: user3, body: { mode: 'adaptive' } })

    let threw404 = false
    try {
      await startLearningSession(req4, res4)
    } catch (err) {
      // ErrorResponse → sẽ được error middleware xử lý nếu chạy qua Express
      // Ở đây ta chỉ cần biết nó KHÔNG tạo session
      threw404 = err.statusCode === 404 || err.message?.includes('No vocabulary history')
    }
    const emptySession = await LearningSession.findOne({ student: user3._id })
    log(
      !emptySession,
      'Không tạo session cho empty student',
      `threw404=${threw404} session=${!!emptySession}`,
    )

    // ========== TEST 5: Adaptive mode — wordId không trùng với session khác ==========
    console.log('\n--- TEST 5: wordId uniqueness giữa các sessions ---')
    // user1 đã có 1 session adaptive → tạo user khác, adaptive, kiểm tra wordId không trùng nhau
    const user5 = await seedStudent()
    const { req: req5, res: res5 } = mockReqRes({ user: user5, body: { mode: 'adaptive' } })
    await startLearningSession(req5, res5)
    const session5 = await LearningSession.findOne({ student: user5._id })

    // wordId có prefix 'adaptive:due-{vocabId}' → vì mỗi user có vocab riêng, ID sẽ khác nhau
    const wordIdsUser5 = session5?.targetWords.map((w) => w.wordId) || []
    const wordIdsUser1 = created?.targetWords.map((w) => w.wordId) || []
    const overlap = wordIdsUser5.filter((id) => wordIdsUser1.includes(id))
    log(
      overlap.length === 0,
      'wordId không trùng giữa 2 user khác nhau',
      `overlap: ${JSON.stringify(overlap)}`,
    )

    await teardown(user5)

    console.log('\n===== KẾT QUẢ =====')
    console.log(`✅ PASS: ${pass}`)
    console.log(`❌ FAIL: ${fail}`)
    console.log(`📊 Total: ${pass + fail}`)
  } catch (err) {
    console.error('\n💥 LỖI NGOÀI Ý MUỐN:', err)
    fail++
  } finally {
    if (user1) await teardown(user1)
    if (user2 && testSet) {
      await teardown(user2)
      await LearningSet.deleteOne({ _id: testSet._id })
    }
    if (user3) await teardown(user3)
    await mongoose.disconnect()
  }

  process.exit(fail > 0 ? 1 : 0)
}

run()
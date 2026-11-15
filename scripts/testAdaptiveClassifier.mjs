/**
 * Giai đoạn 2 — Test Adaptive Word Classifier
 *
 * Chạy: cd server && node scripts/testAdaptiveClassifier.mjs
 * Yêu cầu: MongoDB đang chạy (hoặc dùng cùng .env như app)
 *          Server KHÔNG cần chạy
 */

import mongoose from 'mongoose'
import dotenv from 'dotenv'
import { requireIsolatedTestExecution } from './localTestDatabaseGuard.js'
dotenv.config()

const { url: isolatedUrl } = requireIsolatedTestExecution('testAdaptiveClassifier', {
  envFlag: 'RUN_TEST_ADAPTIVE_CLASSIFIER',
})

import {
  classifyDueWords,
  classifyWeakWords,
  classifyNewWords,
  classifyLibraryWords,
  buildAdaptiveSession,
} from '../src/services/adaptiveWordClassifier.service.js'
import Vocabulary from '../src/models/Vocabulary.js'
import PracticeAttempt from '../src/models/PracticeAttempt.js'

const MONGODB_URI = isolatedUrl.toString()

let pass = 0
let fail = 0
const log = (ok, name, info = '') => {
  const tag = ok ? '✅ PASS' : '❌ FAIL'
  console.log(`${tag}  ${name}${info ? ' — ' + info : ''}`)
  ok ? pass++ : fail++
}

async function setup() {
  await mongoose.connect(MONGODB_URI)
  console.log('→ Connected to', MONGODB_URI)

  // Tạo student test (ObjectId ngẫu nhiên, không cần user thật)
  const testStudent = new mongoose.Types.ObjectId()
  console.log('→ Test studentId:', testStudent.toString())

  // Xoá dữ liệu cũ nếu có (idempotent)
  await Vocabulary.deleteMany({ student: testStudent })
  await PracticeAttempt.deleteMany({ student: testStudent })

  // --- Seed từ vựng ---
  // 3 từ DUE (nextReviewDate <= hôm nay)
  const dueWords = await Vocabulary.insertMany([
    {
      student: testStudent,
      word: 'apple',
      theme: 'Food',
      masteryLevel: 'learning',
      nextReviewDate: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000), // 2 days ago
    },
    {
      student: testStudent,
      word: 'banana',
      theme: 'Food',
      masteryLevel: 'new',
      nextReviewDate: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000),
    },
    {
      student: testStudent,
      word: 'cherry',
      theme: 'Food',
      masteryLevel: 'learning',
      nextReviewDate: null, // never reviewed
    },
  ])

  // 2 từ WEAK (mastery='learning' đã có, thêm 1 từ sai nhiều lần)
  await Vocabulary.insertMany([
    {
      student: testStudent,
      word: 'diligent',
      theme: 'Character',
      masteryLevel: 'learning',
      reviewCount: 2,
    },
    {
      student: testStudent,
      word: 'ambiguous',
      theme: 'Academic',
      masteryLevel: 'learning',
      reviewCount: 1,
    },
  ])

  // 2 từ NEW (chưa từng học)
  await Vocabulary.insertMany([
    {
      student: testStudent,
      word: 'eclipse',
      theme: 'Science',
      masteryLevel: 'new',
    },
    {
      student: testStudent,
      word: 'fossil',
      theme: 'Science',
      masteryLevel: 'new',
    },
  ])

  // 2 từ LIB (mastered)
  await Vocabulary.insertMany([
    {
      student: testStudent,
      word: 'happy',
      theme: 'Emotion',
      masteryLevel: 'mastered',
      reviewCount: 5,
      easeFactor: 2.8,
    },
    {
      student: testStudent,
      word: 'strong',
      theme: 'Emotion',
      masteryLevel: 'mastered',
      reviewCount: 6,
      easeFactor: 2.9,
    },
  ])

  // 1 từ MASTERED sẽ bị sai ≥2 lần → WEAK fallback
  const masteredButWrong = await Vocabulary.create({
    student: testStudent,
    word: 'nuance',
    theme: 'Academic',
    masteryLevel: 'mastered',
    reviewCount: 5,
    easeFactor: 2.5,
  })

  // 1 từ MASTERED nhưng sai ≥2 lần gần đây → WEAK fallback
  const ambiguousVocab = await Vocabulary.findOne({
    student: testStudent,
    word: 'ambiguous',
  })
  await PracticeAttempt.insertMany([
    {
      session: new mongoose.Types.ObjectId(),
      student: testStudent,
      word: 'ambiguous',
      wordId: 'session-x:0',
      questionType: 'multiple_choice',
      questionIndex: 0,
      isCorrect: false,
      selectedAnswer: 'a',
      requestId: 'r1',
    },
    {
      session: new mongoose.Types.ObjectId(),
      student: testStudent,
      word: 'ambiguous',
      wordId: 'session-x:0',
      questionType: 'multiple_choice',
      questionIndex: 0,
      isCorrect: false,
      selectedAnswer: 'b',
      requestId: 'r2',
    },
    {
      session: new mongoose.Types.ObjectId(),
      student: testStudent,
      word: 'nuance',
      wordId: 'session-x:1',
      questionType: 'multiple_choice',
      questionIndex: 0,
      isCorrect: false,
      selectedAnswer: 'x',
      requestId: 'r3',
    },
    {
      session: new mongoose.Types.ObjectId(),
      student: testStudent,
      word: 'nuance',
      wordId: 'session-x:1',
      questionType: 'multiple_choice',
      questionIndex: 0,
      isCorrect: false,
      selectedAnswer: 'y',
      requestId: 'r4',
    },
  ])

  return { testStudent, dueWords }
}

async function teardown(testStudent) {
  await Vocabulary.deleteMany({ student: testStudent })
  await PracticeAttempt.deleteMany({ student: testStudent })
  await mongoose.disconnect()
}

async function run() {
  console.log('===== Giai đoạn 2: Adaptive Word Classifier Test =====\n')
  let testStudent
  try {
    const setupResult = await setup()
    testStudent = setupResult.testStudent

    // ===== TEST 1: classifyDueWords =====
    const due = await classifyDueWords(testStudent, 3)
    log(
      due.length === 3 && due.every((w) => w.category === 'due'),
      'classifyDueWords trả 3 từ due',
      `got ${due.length}: ${due.map((w) => w.word).join(', ')}`,
    )
    log(
      due.every((w) => w.wordId.startsWith('adaptive:due-')),
      'wordId có prefix adaptive:due-',
    )
    log(
      due.every((w) => w.reason && w.reason.length > 0),
      'mỗi từ có reason',
    )

    // ===== TEST 2: classifyWeakWords - nhánh learningWords =====
    const weak1 = await classifyWeakWords(testStudent, 2)
    log(
      weak1.length >= 1 && weak1.every((w) => w.category === 'weak'),
      'classifyWeakWords(trước) trả ≥1 từ weak',
      `got ${weak1.length}: ${weak1.map((w) => w.word).join(', ')}`,
    )
    log(
      weak1.some((w) => w.reason.includes('mastery: learning')),
      'có từ weak do mastery=learning',
    )

    // ===== TEST 2b: classifyWeakWords - nhánh wrongStats (mastered bị sai nhiều) =====
    // Dùng student chỉ có mastered + attempts sai
    const weakStudent = new mongoose.Types.ObjectId()
    await Vocabulary.insertMany([
      {
        student: weakStudent,
        word: 'm1',
        theme: 'T',
        masteryLevel: 'mastered',
        reviewCount: 5,
      },
      {
        student: weakStudent,
        word: 'm2',
        theme: 'T',
        masteryLevel: 'mastered',
        reviewCount: 5,
      },
      {
        student: weakStudent,
        word: 'm3',
        theme: 'T',
        masteryLevel: 'mastered',
        reviewCount: 5,
      },
    ])
    await PracticeAttempt.insertMany([
      {
        session: new mongoose.Types.ObjectId(),
        student: weakStudent,
        word: 'm2',
        wordId: 'x:0',
        questionType: 'multiple_choice',
        questionIndex: 0,
        isCorrect: false,
        selectedAnswer: 'a',
        requestId: 'w1',
      },
      {
        session: new mongoose.Types.ObjectId(),
        student: weakStudent,
        word: 'm2',
        wordId: 'x:0',
        questionType: 'multiple_choice',
        questionIndex: 0,
        isCorrect: false,
        selectedAnswer: 'b',
        requestId: 'w2',
      },
      {
        session: new mongoose.Types.ObjectId(),
        student: weakStudent,
        word: 'm3',
        wordId: 'x:1',
        questionType: 'multiple_choice',
        questionIndex: 0,
        isCorrect: false,
        selectedAnswer: 'a',
        requestId: 'w3',
      },
      {
        session: new mongoose.Types.ObjectId(),
        student: weakStudent,
        word: 'm3',
        wordId: 'x:1',
        questionType: 'multiple_choice',
        questionIndex: 0,
        isCorrect: false,
        selectedAnswer: 'b',
        requestId: 'w4',
      },
    ])
    const weak2 = await classifyWeakWords(weakStudent, 2)
    log(
      weak2.length === 2,
      'classifyWeakWords(nhánh wrongStats) trả 2 từ',
      `got ${weak2.length}: ${weak2.map((w) => w.word).join(', ')}`,
    )
    log(
      weak2.every((w) => w.reason.includes('wrong answers')),
      'fallback lấy từ sai ≥2 lần trong 7 ngày',
      weak2.map((w) => w.reason).join(' | '),
    )
    // Cleanup
    await Vocabulary.deleteMany({ student: weakStudent })
    await PracticeAttempt.deleteMany({ student: weakStudent })

    // ===== TEST 3: classifyNewWords =====
    const newWords = await classifyNewWords(testStudent, 2)
    log(
      newWords.length === 2 && newWords.every((w) => w.category === 'new'),
      'classifyNewWords trả 2 từ new',
      `got ${newWords.length}: ${newWords.map((w) => w.word).join(', ')}`,
    )

    // ===== TEST 4: classifyLibraryWords =====
    const lib = await classifyLibraryWords(testStudent, 2)
    log(
      lib.length === 2 && lib.every((w) => w.category === 'lib'),
      'classifyLibraryWords trả 2 từ lib',
      `got ${lib.length}: ${lib.map((w) => w.word).join(', ')}`,
    )

    // ===== TEST 5: buildAdaptiveSession — happy path =====
    const session = await buildAdaptiveSession(testStudent, {
      sessionSize: 5,
      ratio: { due: 3, weak: 1, new: 1, lib: 0 },
    })
    log(
      session.targets.length === 5,
      'buildAdaptiveSession trả đúng 5 từ',
      `got ${session.targets.length}`,
    )
    log(
      session.breakdown.due === 3,
      'breakdown.due = 3',
      `got ${session.breakdown.due}`,
    )
    log(
      session.breakdown.new === 1,
      'breakdown.new = 1',
      `got ${session.breakdown.new}`,
    )
    log(
      session.breakdown.lib === 0,
      'breakdown.lib = 0 khi ratio lib=0',
      `got ${session.breakdown.lib}`,
    )
    log(
      session.reason.startsWith('due-'),
      'reason string format đúng',
      session.reason,
    )
    log(
      session.targets.every((t) => t.word && t.wordId && t.category),
      'mỗi target có word, wordId, category',
    )

    // ===== TEST 6: Không trùng từ =====
    const words = session.targets.map((t) => t.word)
    const unique = new Set(words)
    log(unique.size === words.length, 'không có từ trùng trong session')

    // ===== TEST 7: wordId unique =====
    const wordIds = session.targets.map((t) => t.wordId)
    const uniqueIds = new Set(wordIds)
    log(
      uniqueIds.size === wordIds.length,
      'không có wordId trùng trong session',
    )

    // ===== TEST 8: Empty student (sinh viên hoàn toàn mới) =====
    const emptyStudent = new mongoose.Types.ObjectId()
    const empty = await buildAdaptiveSession(emptyStudent)
    log(
      empty.targets.length === 0,
      'buildAdaptiveSession trả mảng rỗng khi không có data',
      `got ${empty.targets.length}`,
    )

    // ===== TEST 9: lấp đầy bằng LIB khi không có due/weak/new =====
    // Dùng student mới, chỉ có mastered với nextReviewDate set xa tương lai
    // → không match DUE → phải lấp từ LIB
    const libOnlyStudent = new mongoose.Types.ObjectId()
    const futureDate = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000)
    await Vocabulary.insertMany([
      {
        student: libOnlyStudent,
        word: 'm1',
        theme: 'T',
        masteryLevel: 'mastered',
        reviewCount: 5,
        nextReviewDate: futureDate,
      },
      {
        student: libOnlyStudent,
        word: 'm2',
        theme: 'T',
        masteryLevel: 'mastered',
        reviewCount: 5,
        nextReviewDate: futureDate,
      },
      {
        student: libOnlyStudent,
        word: 'm3',
        theme: 'T',
        masteryLevel: 'mastered',
        reviewCount: 5,
        nextReviewDate: futureDate,
      },
      {
        student: libOnlyStudent,
        word: 'm4',
        theme: 'T',
        masteryLevel: 'mastered',
        reviewCount: 5,
        nextReviewDate: futureDate,
      },
      {
        student: libOnlyStudent,
        word: 'm5',
        theme: 'T',
        masteryLevel: 'mastered',
        reviewCount: 5,
        nextReviewDate: futureDate,
      },
    ])
    const filled = await buildAdaptiveSession(libOnlyStudent, {
      sessionSize: 5,
      ratio: { due: 3, weak: 1, new: 1, lib: 5 },
    })
    log(
      filled.breakdown.lib === 5 && filled.breakdown.due === 0,
      'lấp đầy bằng LIB khi không có due/weak/new',
      `lib=${filled.breakdown.lib}, due=${filled.breakdown.due}`,
    )
    await Vocabulary.deleteMany({ student: libOnlyStudent })

    // ===== TEST 10: Custom ratio =====
    const custom = await buildAdaptiveSession(testStudent, {
      sessionSize: 3,
      ratio: { due: 1, weak: 1, new: 0, lib: 0 },
    })
    log(
      custom.targets.length === 3,
      'custom sessionSize=3 trả đúng 3 từ',
      `got ${custom.targets.length}`,
    )
  } catch (err) {
    console.error('💥 Lỗi:', err)
    fail++
  } finally {
    if (testStudent) await teardown(testStudent)
  }

  console.log(`\n===== Kết quả: ${pass} PASS, ${fail} FAIL =====`)
  process.exit(fail > 0 ? 1 : 0)
}

run()
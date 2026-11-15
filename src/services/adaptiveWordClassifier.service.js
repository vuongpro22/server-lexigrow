/**
 * Adaptive Word Classifier — Giai đoạn 2
 *
 * Phân loại 5 từ cho session adaptive dựa trên trạng thái học của học sinh.
 *
 * 4 nhóm ưu tiên:
 *   1. DUE   - đến hạn ôn tập (Vocabulary.nextReviewDate <= now)
 *   2. WEAK  - đang học / làm sai nhiều gần đây
 *   3. NEW   - từ mới hoàn toàn (masteryLevel='new') hoặc chưa từng học
 *   4. LIB   - fallback từ thư viện Vocabulary đã mastered
 *
 * Output mỗi hàm: { word, wordId, category, reason }[]
 *   wordId được sinh deterministic từ (_id + ':' + index) để khớp schema cũ
 */

import mongoose from 'mongoose'
import Vocabulary from '../models/Vocabulary.js'
import PracticeAttempt from '../models/PracticeAttempt.js'
import { dayBoundary } from '../utils/learning.js'
import { getMasteredWords } from './masteryView.service.js'

// =================== CONFIG ===================
const DEFAULT_SESSION_SIZE = 5

// Tỷ lệ mặc định (ưu tiên theo spec GĐ2)
const DEFAULT_RATIO = { due: 3, weak: 1, new: 1, lib: 0 }

/**
 * Sinh wordId nhất quán với schema hiện tại của LearningSession:
 *   set._id + ':' + index
 * Với adaptive session, "set" chính là một marker cố định để frontend nhận diện.
 */
function makeWordId(marker, index) {
  return `${marker}:${index}`
}

/**
 * Marker dùng cho tất cả wordId trong adaptive session.
 * Cố định → nếu cùng 1 session gọi lại, wordId không đổi → PracticeAttempt unique
 * constraint (student + requestId + word) vẫn nhất quán.
 */
const ADAPTIVE_MARKER = 'adaptive'

// =================== CLASSIFIERS ===================

/**
 * DUE: từ có nextReviewDate <= hôm nay (kể cả null = chưa review bao giờ).
 * Đây là nhóm ưu tiên cao nhất — học sinh phải ôn đúng hạn SRS.
 *
 * @param {string|ObjectId} studentId
 * @param {number} limit - số từ tối đa cần lấy
 * @returns {Promise<Array<{word, wordId, category, reason, vocabularyId}>>}
 */
export async function classifyDueWords(studentId, limit = 3) {
  const now = new Date()
  const today = dayBoundary(now, 0)
  // Ưu tiên: từ CHƯA mastered mà tới hạn (vì mastered thì EF cao, interval dài,
  // null review date của mastered là do seed thiếu, không ép review)
  // Sau đó mới tới mastered overdue
  const words = await Vocabulary.find({
    student: studentId,
    $and: [
      {
        $or: [
          { nextReviewDate: { $lte: today } },
          { nextReviewDate: null, masteryLevel: { $ne: 'mastered' } },
        ],
      },
    ],
  })
    .sort({ nextReviewDate: 1, createdAt: -1 })
    .limit(limit)
    .lean()

  return words.map((w, i) => ({
    word: w.word,
    wordId: makeWordId(ADAPTIVE_MARKER, `due-${w._id}`),
    category: 'due',
    reason: w.nextReviewDate
      ? `due ${formatDueReason(w.nextReviewDate, now)}`
      : 'never reviewed',
    vocabularyId: w._id,
    masteryLevel: w.masteryLevel,
    nextReviewDate: w.nextReviewDate,
    theme: w.theme,
  }))
}

/**
 * WEAK: từ masteryLevel='learning' HOẶC sai ≥2 lần trong 7 ngày gần nhất.
 * Nhóm này cần luyện thêm để đạt 'mastered'.
 */
export async function classifyWeakWords(studentId, limit = 1) {
  // 1) Lấy từ đang học (masteryLevel='learning')
  const learningWords = await Vocabulary.find({
    student: studentId,
    masteryLevel: 'learning',
  })
    .sort({ updatedAt: -1 })
    .limit(limit)
    .lean()

  if (learningWords.length >= limit) {
    return learningWords.map((w) => ({
      word: w.word,
      wordId: makeWordId(ADAPTIVE_MARKER, `weak-${w._id}`),
      category: 'weak',
      reason: `mastery: learning (${w.reviewCount} reviews)`,
      vocabularyId: w._id,
      masteryLevel: w.masteryLevel,
      theme: w.theme,
    }))
  }

  // 2) Fallback: tìm từ sai ≥2 lần trong 7 ngày gần đây (kể cả mastered cũ)
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
  const wrongStats = await PracticeAttempt.aggregate([
    {
      $match: {
        student: new mongoose.Types.ObjectId(studentId),
        isCorrect: false,
        createdAt: { $gte: sevenDaysAgo },
      },
    },
    { $group: { _id: '$word', wrongs: { $sum: 1 } } },
    { $match: { wrongs: { $gte: 2 } } },
    { $sort: { wrongs: -1 } },
    { $limit: limit },
  ])

  // Nếu learningWords đã có 1 từ, chỉ thêm từ mới (giới hạn tổng = limit)
  const need = limit - learningWords.length
  const wrongWords = wrongStats.slice(0, need)

  // Tra cứu vocab tương ứng
  const vocabWords = wrongWords.length
    ? await Vocabulary.find({
        student: studentId,
        word: { $in: wrongWords.map((w) => w._id) },
      }).lean()
    : []
  const vocabByWord = new Map(vocabWords.map((v) => [v.word, v]))

  const extra = wrongWords.map((stat) => {
    const v = vocabByWord.get(stat._id)
    return {
      word: stat._id,
      wordId: makeWordId(
        ADAPTIVE_MARKER,
        `weak-${v?._id || stat._id}`,
      ),
      category: 'weak',
      reason: `${stat.wrongs} wrong answers in 7 days`,
      vocabularyId: v?._id || null,
      masteryLevel: v?.masteryLevel || 'unknown',
      theme: v?.theme || null,
    }
  })

  return [
    ...learningWords.map((w) => ({
      word: w.word,
      wordId: makeWordId(ADAPTIVE_MARKER, `weak-${w._id}`),
      category: 'weak',
      reason: `mastery: learning (${w.reviewCount} reviews)`,
      vocabularyId: w._id,
      masteryLevel: w.masteryLevel,
      theme: w.theme,
    })),
    ...extra,
  ]
}

/**
 * NEW: từ mới hoàn toàn — masteryLevel='new' HOẶC không tồn tại trong Vocabulary.
 * Đây là từ đầu tiên học sinh gặp → dùng cho việc mở rộng vốn từ.
 */
export async function classifyNewWords(studentId, limit = 1) {
  const newWords = await Vocabulary.find({
    student: studentId,
    masteryLevel: 'new',
  })
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean()

  return newWords.map((w) => ({
    word: w.word,
    wordId: makeWordId(ADAPTIVE_MARKER, `new-${w._id}`),
    category: 'new',
    reason: 'new vocabulary, ready to start',
    vocabularyId: w._id,
    masteryLevel: w.masteryLevel,
    theme: w.theme,
  }))
}

/**
 * LIB: từ đã mastered từ thư viện Vocabulary, dùng để review nhanh (warm-up).
 * Chỉ dùng khi DUE/WEAK/NEW không đủ số từ cần thiết.
 */
export async function classifyLibraryWords(studentId, limit = 0) {
  if (limit <= 0) return []

  // Mastered is derived from verified essay evidence, not from a stored field.
  const mastered = await getMasteredWords(studentId)
  if (!mastered.size) return []

  const libWords = await Vocabulary.find({
    student: studentId,
    word: { $in: [...mastered] },
  })
    .sort({ updatedAt: -1 })
    .limit(limit)
    .lean()

  return libWords.map((w) => ({
    word: w.word,
    wordId: makeWordId(ADAPTIVE_MARKER, `lib-${w._id}`),
    category: 'lib',
    reason: 'mastered — light review',
    vocabularyId: w._id,
    masteryLevel: 'mastered',
    theme: w.theme,
  }))
}

// =================== BUILDER ===================

/**
 * Build adaptive session: gọi 4 classifier, kết hợp theo tỷ lệ ratio,
 * đảm bảo không trùng từ, tổng = sessionSize (mặc định 5).
 *
 * @param {string|ObjectId} studentId
 * @param {object} options
 * @param {number} options.sessionSize - tổng số từ (default 5)
 * @param {{due, weak, new, lib}} options.ratio - phân bổ nhóm
 * @returns {Promise<{
 *   targets: Array<{word, wordId, theme, masteryLevel, vocabularyId}>,
 *   breakdown: {due, weak, new, lib},
 *   reason: string
 * }>}
 */
export async function buildAdaptiveSession(
  studentId,
  { sessionSize = DEFAULT_SESSION_SIZE, ratio = DEFAULT_RATIO } = {},
) {
  // Tỷ lệ yêu cầu, nhưng nếu không đủ thì lấp đầy bằng nhóm kế tiếp
  const targets = []
  const seen = new Set()
  const breakdown = { due: 0, weak: 0, new: 0, lib: 0 }

  // Hàm tiện ích: lấy N từ từ classifier, bỏ qua từ đã thấy
  const take = async (classifier, want, category) => {
    if (want <= 0) return []
    const pool = await classifier(studentId, want + seen.size)
    const picked = []
    for (const item of pool) {
      if (seen.has(item.word)) continue
      seen.add(item.word)
      picked.push(item)
      breakdown[category]++
      if (picked.length >= want) break
    }
    return picked
  }

  // Ưu tiên: due > weak > new > lib
  // Mỗi nhóm yêu cầu `ratio[cat]`, nếu thiếu thì lấp bằng nhóm sau
  const duePicks = await take(classifyDueWords, ratio.due, 'due')
  targets.push(...duePicks)

  const weakPicks = await take(
    classifyWeakWords,
    ratio.weak + Math.max(0, ratio.due - duePicks.length),
    'weak',
  )
  targets.push(...weakPicks)

  const newPicks = await take(
    classifyNewWords,
    ratio.new +
      Math.max(
        0,
        ratio.due - duePicks.length +
          ratio.weak - (weakPicks.length - Math.max(0, ratio.due - duePicks.length)),
      ),
    'new',
  )
  targets.push(...newPicks)

  // Cuối cùng, lấp đầy bằng LIB nếu vẫn thiếu
  if (targets.length < sessionSize) {
    const libPicks = await take(
      classifyLibraryWords,
      sessionSize - targets.length,
      'lib',
    )
    targets.push(...libPicks)
  }

  // Nếu tất cả đều rỗng (sinh viên hoàn toàn mới) → fallback trả về mảng rỗng
  // để caller xử lý (giữ nguyên behavior của session cũ, không tự invent từ)

  // Rút gọn field cho output giống LearningSession.targetWords
  const slimTargets = targets.slice(0, sessionSize).map((t) => ({
    word: t.word,
    wordId: t.wordId,
    theme: t.theme || 'General',
    category: t.category,
    vocabularyId: t.vocabularyId || null,
    masteryLevel: t.masteryLevel || null,
    reason: t.reason,
  }))

  // Chuỗi lý do tổng hợp, ví dụ: "due-3,weak-1,new-1,lib-0"
  const reason = `due-${breakdown.due},weak-${breakdown.weak},new-${breakdown.new},lib-${breakdown.lib}`

  return {
    targets: slimTargets,
    breakdown,
    reason,
  }
}

// =================== HELPERS ===================

function formatDueReason(nextDate, now) {
  const diffMs = now.getTime() - new Date(nextDate).getTime()
  const days = Math.floor(diffMs / (24 * 60 * 60 * 1000))
  if (days <= 0) return 'today'
  if (days === 1) return '1 day overdue'
  return `${days} days overdue`
}
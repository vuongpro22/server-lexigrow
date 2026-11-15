import Vocabulary from '../models/Vocabulary.js'
import WordUsageEvidence from '../models/WordUsageEvidence.js'
import LearningSet from '../models/LearningSet.js'
import LearningSession from '../models/LearningSession.js'
import EssayRevision from '../models/EssayRevision.js'
import Class from '../models/Class.js'
import Essay from '../models/Essay.js'
import asyncHandler from '../utils/asyncHandler.js'
import { masteredPipeline } from '../services/wordEvidence.service.js'
import { getMasteredWords } from '../services/masteryView.service.js'
import { fail, objectId, text, integer, dayKey } from '../utils/learning.js'
import GardenWaterLog from '../models/GardenWaterLog.js'
import { getUserEffectiveTier } from '../services/tier.service.js'
export const getActiveVocabulary = asyncHandler(async (req, res) => {
  const student = req.user._id
  const [libraryWords, masteredRows, retainedCount] = await Promise.all([
    Vocabulary.find({ student }).select('word').lean(),
    WordUsageEvidence.aggregate(masteredPipeline(student)),
    Vocabulary.countDocuments({
      student,
      reviewInterval: { $gte: 7 },
      reviewCount: { $gt: 0 },
    }),
  ])
  const savedCount = libraryWords.length
  const librarySet = new Set(libraryWords.map((word) => String(word.word || '').toLowerCase()))
  const masteredCount = masteredRows.filter((row) => librarySet.has(String(row._id).toLowerCase())).length
  res.json({
    success: true,
    data: { savedCount, retainedCount, masteredCount },
  })
})
export const getWordEvidence = asyncHandler(async (req, res) => {
  const wordParam = req.params.word || req.query.word
  const page = integer(req.query.page, 1, 1, 100000),
    limit = integer(req.query.limit, 20, 1, 100)
  const query = { student: req.user._id, isVerifiedCorrect: true }
  if (wordParam) {
    query.word = text(wordParam, 'word', 100).toLowerCase()
  }
  const [evidence, total, mastered] = await Promise.all([
    WordUsageEvidence.find(query)
      .sort({ usedAt: -1, _id: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    WordUsageEvidence.countDocuments(query),
    getMasteredWords(req.user._id),
  ])
  res.json({
    success: true,
    // isMastered is the evidence-pipeline verdict for the whole word, so the
    // wall never claims "mastered" from a single essay.
    data: evidence.map((item) => ({
      ...item,
      isMastered: mastered.has(String(item.word || '').toLowerCase()),
    })),
    total,
    page,
    limit,
  })
})
export const gardenStage = (count) =>
  count === 0
    ? 'seed'
    : count <= 2
      ? 'sprout'
      : count <= 5
        ? 'leafy'
        : 'blooming'
export const getGardenStatus = asyncHandler(async (req, res) => {
  const [mastered, sessions, evidence] = await Promise.all([
    WordUsageEvidence.aggregate(masteredPipeline(req.user._id)),
    LearningSession.find({ student: req.user._id })
      .select('theme targetWords learningSetSlug')
      .lean(),
    WordUsageEvidence.find({ student: req.user._id, isVerifiedCorrect: true })
      .select('word theme contextSentence usedAt')
      .sort({ usedAt: -1 })
      .lean(),
  ])
  const totals = new Map()
  const slugs = new Map()
  for (const session of sessions) {
    if (!session.theme) continue
    if (session.learningSetSlug) slugs.set(session.theme, session.learningSetSlug)
    const words = Array.isArray(session.targetWords) ? session.targetWords : []
    const total = words.reduce((set, item) => {
      const word = typeof item === 'string' ? item : item?.word
      if (word) set.add(String(word).toLowerCase())
      return set
    }, new Set()).size
    totals.set(session.theme, Math.max(totals.get(session.theme) || 0, total))
  }
  for (const word of mastered) {
    for (const theme of word.themes.filter(Boolean)) {
      totals.set(theme, totals.get(theme) || 0)
    }
  }
  const masteredByTheme = new Map()
  for (const word of mastered)
    for (const theme of word.themes.filter(Boolean))
      masteredByTheme.set(theme, (masteredByTheme.get(theme) || 0) + 1)

  // The detail panel lists the words that back each topic together with the
  // essay sentence that proves the usage. Older evidence rows can share a word
  // inside one theme, so keep only the most recent sentence per word.
  const masteredSet = new Set(mastered.map((word) => String(word._id).toLowerCase()))
  const wordsByTheme = new Map()
  for (const row of evidence) {
    if (!row.theme) continue
    const list = wordsByTheme.get(row.theme) || []
    if (list.some((item) => item.word.toLowerCase() === String(row.word).toLowerCase())) continue
    list.push({
      word: row.word,
      status: masteredSet.has(String(row.word).toLowerCase()) ? 'mastered' : 'learning',
      evidence: row.contextSentence || '',
    })
    wordsByTheme.set(row.theme, list)
  }

  // The CTA must link with a URL-safe identifier. Themes are display titles
  // (they can contain "&"), so map each theme to its published learning set
  // slug and fall back to a title lookup for legacy sessions.
  const missing = [...totals.keys()].filter((theme) => !slugs.has(theme))
  if (missing.length) {
    const sets = await LearningSet.find({ title: { $in: missing } })
      .select('slug title')
      .lean()
    for (const set of sets) if (set.title && set.slug) slugs.set(set.title, set.slug)
  }

  res.json({
    success: true,
    // Distinct mastered words across every theme (a word used in two themes
    // must not be counted twice by the garden hero).
    totalMasteredDistinct: mastered.length,
    data: [...totals]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([theme, totalCount]) => {
        const masteredCount = masteredByTheme.get(theme) || 0
        const learningSetSlug = slugs.get(theme) || null
        return {
          theme,
          slug: learningSetSlug,
          learningSetSlug,
          totalCount,
          masteredCount,
          stage: gardenStage(masteredCount),
          words: wordsByTheme.get(theme) || [],
        }
      }),
  })
})
// Watering is a gamified action only: it never writes Vocabulary.masteryLevel.
// masteredCount is always derived from WordUsageEvidence via masteredPipeline,
// so this endpoint re-reads that state instead of creating fake mastery.
export const waterGarden = asyncHandler(async (req, res) => {
  const key = text(req.body.theme || req.body.slug, 'theme', 100)
  const student = req.user._id
  const sessions = await LearningSession.find({
    student,
    $or: [{ theme: key }, { learningSetSlug: key }],
  })
    .select('theme learningSetSlug')
    .lean()
  const session = sessions[0]
  if (!session) fail('Topic not found in your garden', 404)
  const theme = session.theme

  // Watering is a small daily ritual, not a mastery shortcut: it is written to
  // its own log so the daily limit can be enforced, and it never touches
  // Vocabulary.masteryLevel or the evidence pipeline.
  const { tier } = await getUserEffectiveTier(req.user)
  const limit = tier === 'pro' ? 20 : tier === 'plus' ? 8 : 3
  const zone = req.user.learningProfile?.timezone || 'Asia/Ho_Chi_Minh'
  const day = dayKey(new Date(), zone)

  let log = null
  for (let attempt = 0; attempt < 3 && !log; attempt += 1) {
    try {
      log = await GardenWaterLog.findOneAndUpdate(
        { student, theme, day, count: { $lt: limit } },
        { $inc: { count: 1 } },
        { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
      )
    } catch (err) {
      if (err?.code !== 11000) throw err
      // A concurrent first water created the counter document between our
      // filter and the upsert. Retry the plain increment instead of reporting
      // the quota as exhausted.
      log = await GardenWaterLog.findOneAndUpdate(
        { student, theme, day, count: { $lt: limit } },
        { $inc: { count: 1 } },
        { returnDocument: 'after' },
      )
    }
  }
  if (!log) {
    throw new (await import('../utils/ErrorResponse.js')).default(
      'You have watered this plant enough for today',
      429,
    )
  }

  const mastered = await WordUsageEvidence.aggregate(masteredPipeline(student))
  let masteredCount = 0
  for (const word of mastered)
    if (word.themes.filter(Boolean).includes(theme)) masteredCount += 1
  res.json({
    success: true,
    data: {
      theme,
      slug: session.learningSetSlug || null,
      learningSetSlug: session.learningSetSlug || null,
      masteredCount,
      stage: gardenStage(masteredCount),
      watered: true,
      day,
      watersUsed: log.count,
      watersLeft: Math.max(0, limit - log.count),
      dailyLimit: limit,
    },
  })
})
export const getLexicalErrors = asyncHandler(async (req, res) => {
  const classId = objectId(req.params.classId, 'classId')
  const cls = await Class.findOne({ _id: classId, teacher: req.user._id })
  if (!cls) fail('Class not found', 404)
  const limit = integer(req.query.limit, 20, 1, 100),
    page = integer(req.query.page, 1, 1, 100000)
  // Aggregate through essays so only work belonging to this class is visible.
  const rows = await Essay.aggregate([
    { $match: { class: classId, student: { $in: cls.students } } },
    {
      $lookup: {
        from: EssayRevision.collection.name,
        localField: '_id',
        foreignField: 'originalEssay',
        as: 'revisions',
      },
    },
    { $unwind: '$revisions' },
    { $match: { 'revisions.analysisStatus': 'succeeded' } },
    { $sort: { 'revisions.revisionNumber': -1 } },
    { $group: { _id: '$_id', revision: { $first: '$revisions' } } },
    { $unwind: '$revision.targetWordResults' },
    {
      $match: {
        'revision.targetWordResults.issueType': {
          $in: ['collocation', 'word_form'],
        },
        'revision.targetWordResults.status': {
          $in: ['incorrect', 'needs_improvement'],
        },
      },
    },
    {
      $group: {
        _id: {
          word: '$revision.targetWordResults.word',
          issueType: '$revision.targetWordResults.issueType',
        },
        count: { $sum: 1 },
      },
    },
    { $sort: { count: -1, '_id.word': 1 } },
    {
      $facet: {
        data: [{ $skip: (page - 1) * limit }, { $limit: limit }],
        total: [{ $count: 'count' }],
      },
    },
  ])
  res.json({
    success: true,
    data: (rows[0]?.data || []).map((r) => ({ ...r._id, count: r.count })),
    total: rows[0]?.total[0]?.count || 0,
    page,
    limit,
  })
})
export async function validateAssignmentLearningSet(value) {
  if (value === null) return null
  const id = objectId(value, 'learningSetId')
  if (!(await LearningSet.exists({ _id: id, status: 'published' })))
    fail('Published learning set not found', 404)
  return id
}

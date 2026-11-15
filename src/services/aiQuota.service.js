import { dayBoundary, dayKey } from '../utils/learning.js'
import AIQuotaBucket from '../models/AIQuotaBucket.js'
import Essay from '../models/Essay.js'
import EssayRevision from '../models/EssayRevision.js'
import { getUserEffectiveTier } from './tier.service.js'

const TIMEZONE = 'Asia/Ho_Chi_Minh'

function getPeriod(now) {
  return { day: dayKey(now, TIMEZONE), start: dayBoundary(now, 0, TIMEZONE), end: dayBoundary(now, 1, TIMEZONE) }
}

function withSession(query, session) {
  return session && typeof query.session === 'function' ? query.session(session) : query
}

async function getLegacyUsage(student, start, end, session) {
  const essays = withSession(Essay.countDocuments({
    student,
    status: { $in: ['submitted', 'reviewed'] },
    submittedAt: { $gte: start, $lt: end },
  }), session)
  const revisions = withSession(EssayRevision.countDocuments({
    student,
    revisionNumber: { $gt: 1 },
    createdAt: { $gte: start, $lt: end },
  }), session)
  const [essayCount, revisionCount] = await Promise.all([essays, revisions])
  return essayCount + revisionCount
}

async function ensureBucket(student, { day, start, end }, session) {
  const existing = await withSession(AIQuotaBucket.findOne({ student, day }), session)
  if (existing) return existing
  const legacyUsed = await getLegacyUsage(student, start, end, session)
  try {
    return await AIQuotaBucket.findOneAndUpdate(
      { student, day },
      { $setOnInsert: { student, day, legacyUsed, consumed: 0, used: legacyUsed, reserved: 0, reservations: [] } },
      { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true, ...(session ? { session } : {}) },
    )
  } catch (error) {
    if (error?.code !== 11000) throw error
    return withSession(AIQuotaBucket.findOne({ student, day }), session)
  }
}

async function loadReservation(student, requestId, session) {
  let query = AIQuotaBucket.findOne({ student, 'reservations.requestId': requestId })
  query = withSession(query, session)
  if (typeof query.sort === 'function') query = query.sort({ day: -1 })
  return query
}

export async function ensureDailyEssayQuotaBucket({ student, now = new Date() } = {}) {
  if (!student) throw new TypeError('A student is required')
  const tierInfo = await getUserEffectiveTier(student)
  const currentPeriod = getPeriod(now)
  const bucket = await ensureBucket(student, currentPeriod)
  return {
    day: currentPeriod.day,
    usedToday: bucket.legacyUsed + bucket.consumed + bucket.reserved,
    limit: tierInfo.isUnlimitedAi ? 9999 : tierInfo.dailyAiEssayLimit,
    tierInfo,
  }
}

export async function checkDailyEssayQuota(userOrId, now = new Date()) {
  const student = typeof userOrId === 'object' ? userOrId._id || userOrId.id : userOrId
  const tierInfo = await getUserEffectiveTier(userOrId)
  if (tierInfo.isUnlimitedAi) return { canSubmit: true, usedToday: 0, limit: 9999, remaining: 9999, tierInfo }
  const bucket = await ensureBucket(student, getPeriod(now))
  const usedToday = bucket.legacyUsed + bucket.consumed + bucket.reserved
  const limit = tierInfo.dailyAiEssayLimit
  return { canSubmit: usedToday < limit, usedToday, limit, remaining: Math.max(0, limit - usedToday), tierInfo }
}

export async function consumeDailyEssayQuota(userOrId, { now = new Date(), session, kind = 'submission', requestId } = {}) {
  const student = typeof userOrId === 'object' && userOrId !== null
    ? (userOrId._id || userOrId.id)
    : userOrId

  if (!student) throw new TypeError('A student or userId is required')

  const tierInfo = await getUserEffectiveTier(userOrId)
  if (tierInfo.isUnlimitedAi) {
    return {
      allowed: true,
      success: true,
      canSubmit: true,
      consumed: true,
      unlimited: true,
      usedToday: 0,
      limit: 9999,
      remaining: 9999,
      tierInfo,
    }
  }

  const currentPeriod = getPeriod(now)
  const bucket = await ensureBucket(student, currentPeriod, session)
  const limit = tierInfo.dailyAiEssayLimit

  const filter = {
    _id: bucket._id,
    $expr: {
      $lt: [{ $add: ['$legacyUsed', '$consumed', '$reserved'] }, limit],
    },
  }

  const update = {
    $inc: { consumed: 1, used: 1 },
  }
  if (requestId) {
    update.$push = {
      reservations: {
        requestId,
        state: 'consumed',
        kind: kind === 'revision' ? 'revision' : 'submission',
      },
    }
  }

  const updated = await AIQuotaBucket.findOneAndUpdate(
    filter,
    update,
    { returnDocument: 'after', ...(session ? { session } : {}) },
  )

  if (updated) {
    const usedToday = (updated.legacyUsed || 0) + (updated.consumed || 0) + (updated.reserved || 0)
    return {
      allowed: true,
      success: true,
      canSubmit: true,
      consumed: true,
      unlimited: false,
      usedToday,
      limit,
      remaining: Math.max(0, limit - usedToday),
      tierInfo,
      day: currentPeriod.day,
      bucket: updated,
    }
  }

  const latest = await withSession(AIQuotaBucket.findOne({ _id: bucket._id }), session)
  const usedToday = latest ? ((latest.legacyUsed || 0) + (latest.consumed || 0) + (latest.reserved || 0)) : limit
  return {
    allowed: false,
    success: false,
    canSubmit: false,
    consumed: false,
    unlimited: false,
    usedToday,
    limit,
    remaining: 0,
    tierInfo,
    day: currentPeriod.day,
  }
}

export async function reserveDailyEssayQuota({ student, requestId, kind, now = new Date(), session, deferLedgerWrite = false } = {}) {
  if (!student || typeof requestId !== 'string' || !requestId.trim() || requestId.length > 128 || !['submission', 'revision'].includes(kind)) {
    throw new TypeError('Valid student, requestId, and quota kind are required')
  }
  const currentPeriod = getPeriod(now)
  const bucket = deferLedgerWrite
    ? await withSession(AIQuotaBucket.findOne({ student, day: currentPeriod.day }), session)
    : await ensureBucket(student, currentPeriod, session)
  const tierInfo = await getUserEffectiveTier(student)
  if (!bucket) {
    if (deferLedgerWrite) throw Object.assign(new Error('AI quota ledger is unavailable'), { code: 'AI_QUOTA_LEDGER_UNAVAILABLE', status: 503 })
    return { reserved: false, day: currentPeriod.day, tierInfo }
  }
  const priorBucket = await loadReservation(student, requestId, session)
  const priorEntry = priorBucket?.reservations.find((item) => item.requestId === requestId)
  if (priorEntry && priorEntry.state !== 'released') {
    return { reserved: true, duplicate: true, state: priorEntry.state, day: priorBucket.day, unlimited: tierInfo.isUnlimitedAi, tierInfo }
  }
  if (deferLedgerWrite && priorEntry?.state === 'released') {
    return { reserved: false, day: currentPeriod.day, tierInfo }
  }

  const sameDayEntry = bucket.reservations.find((item) => item.requestId === requestId)
  const limit = tierInfo.isUnlimitedAi ? Number.POSITIVE_INFINITY : tierInfo.dailyAiEssayLimit
  const filter = { _id: bucket._id, $expr: { $lt: [{ $add: ['$legacyUsed', '$consumed', '$reserved'] }, limit] } }
  const update = sameDayEntry?.state === 'released'
    ? { $inc: { reserved: 1 }, $set: { 'reservations.$.state': 'reserved', 'reservations.$.kind': kind } }
    : { $inc: { reserved: 1 }, $push: { reservations: { requestId, state: 'reserved', kind } } }
  const query = sameDayEntry?.state === 'released'
    ? { ...filter, reservations: { $elemMatch: { requestId, state: 'released' } } }
    : { ...filter, 'reservations.requestId': { $ne: requestId } }
  const updated = await AIQuotaBucket.findOneAndUpdate(query, update, { returnDocument: 'after', ...(session ? { session } : {}) })
  if (updated) return { reserved: true, duplicate: false, state: 'reserved', day: currentPeriod.day, unlimited: tierInfo.isUnlimitedAi, tierInfo }
  const latest = await withSession(AIQuotaBucket.findOne({ _id: bucket._id }), session)
  const racedEntry = latest?.reservations.find((item) => item.requestId === requestId)
  if (racedEntry && racedEntry.state !== 'released') {
    return { reserved: true, duplicate: true, state: racedEntry.state, day: currentPeriod.day, unlimited: tierInfo.isUnlimitedAi, tierInfo }
  }
  return { reserved: false, day: currentPeriod.day, tierInfo }
}

export async function settleDailyEssayQuota({ student, requestId, day, outcome, session } = {}) {
  if (!student || typeof requestId !== 'string' || !requestId.trim() || !['consume', 'release'].includes(outcome)) {
    throw new TypeError('Valid student, requestId, and quota outcome are required')
  }
  const bucket = day
    ? await withSession(AIQuotaBucket.findOne({ student, day }), session)
    : await loadReservation(student, requestId, session)
  if (!bucket) return { settled: false, reason: 'reservation_not_found' }
  const entry = bucket.reservations.find((item) => item.requestId === requestId)
  if (!entry) return { settled: false, reason: 'reservation_not_found' }
  if (entry.state === 'consumed') return { settled: outcome === 'consume', duplicate: true, state: 'consumed' }
  if (entry.state === 'released' && outcome === 'release') return { settled: true, duplicate: true, state: 'released' }
  const filter = { _id: bucket._id, reservations: { $elemMatch: { requestId, state: entry.state } } }
  const update = entry.state === 'reserved' && outcome === 'consume'
    ? { $inc: { reserved: -1, consumed: 1 }, $set: { 'reservations.$.state': 'consumed' } }
    : entry.state === 'reserved'
      ? { $inc: { reserved: -1 }, $set: { 'reservations.$.state': 'released' } }
      : { $inc: { consumed: 1 }, $set: { 'reservations.$.state': 'consumed' } }
  const result = await AIQuotaBucket.updateOne(filter, update, session ? { session } : {})
  if (result.modifiedCount) return { settled: true, duplicate: false, state: outcome === 'consume' ? 'consumed' : 'released' }
  const latest = await withSession(AIQuotaBucket.findOne({ _id: bucket._id }), session)
  const settled = latest?.reservations.find((item) => item.requestId === requestId)
  return { settled: settled?.state === (outcome === 'consume' ? 'consumed' : 'released'), duplicate: true, state: settled?.state || 'missing' }
}

export async function settleHistoryQuota(entry) {
  if (!entry?.quota?.student || !entry.quota.requestId || !entry.quota.day || !entry.quota.outcome) {
    return { settled: false, reason: 'unmetered_history' }
  }
  return settleDailyEssayQuota({ student: entry.quota.student, requestId: entry.quota.requestId, day: entry.quota.day, outcome: entry.quota.outcome })
}

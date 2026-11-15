import mongoose from 'mongoose'
import DailyQuest from '../models/DailyQuest.js'
import GamificationProfile from '../models/GamificationProfile.js'
import GameResult from '../models/GameResult.js'
import LevelRule from '../models/LevelRule.js'
import RewardGrant from '../models/RewardGrant.js'
import XpEvent from '../models/XpEvent.js'
import XpQuota from '../models/XpQuota.js'
import { DEFAULT_LEVEL_RULES, XP_RULES } from '../constants/gamification.js'
import { dayBoundary, dayKey } from '../utils/learning.js'
import { questXpReward } from './dailyQuest.service.js'

const TIMEZONE = 'Asia/Ho_Chi_Minh'

const objectId = (value) => new mongoose.Types.ObjectId(value)

export async function ensureDefaultLevelRules() {
  const count = await LevelRule.estimatedDocumentCount()
  if (count > 0) return
  await LevelRule.insertMany(DEFAULT_LEVEL_RULES)
}

export async function getLevelRules() {
  const rules = await LevelRule.find({ isActive: true }).sort({ minXp: 1 }).lean()
  return rules.length ? rules : DEFAULT_LEVEL_RULES
}

export function levelForXp(totalXp, rules) {
  let current = rules[0] || DEFAULT_LEVEL_RULES[0]
  for (const rule of rules) {
    if (totalXp >= rule.minXp) current = rule
  }
  return current
}

export function levelProgress(totalXp, currentRule, rules) {
  const index = rules.findIndex((rule) => rule.level === currentRule.level)
  const next = index >= 0 ? rules[index + 1] : null
  if (!next) {
    return { minXp: currentRule.minXp, nextLevelXp: null, progressPercent: 100 }
  }
  const span = Math.max(1, next.minXp - currentRule.minXp)
  return {
    minXp: currentRule.minXp,
    nextLevelXp: next.minXp,
    progressPercent: Math.max(
      0,
      Math.min(100, Math.round(((totalXp - currentRule.minXp) / span) * 100)),
    ),
  }
}

export async function getXpToday(studentId, sourceType) {
  return sumXp(objectId(studentId), {
    sourceType,
    $or: [
      { quotaDay: dayKey(new Date(), TIMEZONE) },
      { $and: [{ quotaDay: null }, { createdAt: { $gte: dayBoundary(new Date(), 0, TIMEZONE) } }] },
    ],
  })
}

let xpIndexesPromise

async function ensureXpIndexes() {
  if (!xpIndexesPromise) {
    xpIndexesPromise = Promise.all([XpEvent.createIndexes(), XpQuota.createIndexes()]).catch((err) => {
      xpIndexesPromise = null
      throw err
    })
  }
  return xpIndexesPromise
}

async function existingXpEvent(student, sourceType, sourceId) {
  return XpEvent.findOne({ student, sourceType, sourceId: String(sourceId) })
    .select('amount')
    .lean()
}

function quotaDayStart(day) {
  return dayBoundary(new Date(`${day}T12:00:00.000Z`), 0, TIMEZONE)
}

async function reserveDailyXp(student, sourceType, sourceId, amount, cap) {
  const existingReservation = await XpQuota.findOne({
    student,
    sourceType,
    'reservations.sourceId': String(sourceId),
  }).lean()
  if (existingReservation) {
    const reservation = existingReservation.reservations.find(
      (item) => item.sourceId === String(sourceId),
    )
    return {
      allowed: true,
      amount: reservation?.amount || amount,
      day: existingReservation.day,
    }
  }

  const now = new Date()
  const day = dayKey(now, TIMEZONE)
  const boundary = dayBoundary(now, 0, TIMEZONE)
  const used = await sumXp(student, {
    sourceType,
    $or: [
      { quotaDay: day },
      { $and: [{ quotaDay: null }, { createdAt: { $gte: boundary } }] },
    ],
  })
  try {
    await XpQuota.findOneAndUpdate(
      { student, sourceType, day },
      { $setOnInsert: { used, reservations: [] } },
      { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
    )
  } catch (err) {
    // A concurrent first reservation may win the unique student/type/day key.
    // Do not swallow unrelated duplicate keys (e.g. reservation-index collisions).
    if (err?.code !== 11000) throw err
    const sameDayQuota = await XpQuota.exists({ student, sourceType, day })
    if (!sameDayQuota) throw err
  }

  const reserved = await XpQuota.findOneAndUpdate(
    {
      student,
      sourceType,
      day,
      used: { $lte: cap - amount },
      'reservations.sourceId': { $ne: String(sourceId) },
    },
    {
      $inc: { used: amount },
      $push: { reservations: { sourceId: String(sourceId), amount } },
    },
    { returnDocument: 'after' },
  ).lean()
  if (reserved) return { allowed: true, amount, day: reserved.day }

  // Another request may have reserved this exact source while we contended.
  const racedReservation = await XpQuota.findOne({
    student,
    sourceType,
    'reservations.sourceId': String(sourceId),
  }).lean()
  if (racedReservation) {
    const reservation = racedReservation.reservations.find(
      (item) => item.sourceId === String(sourceId),
    )
    return {
      allowed: true,
      amount: reservation?.amount || amount,
      day: racedReservation.day,
    }
  }
  return { allowed: false, amount: 0 }
}

/**
 * Award a batch under a daily cap. A single-document atomic reservation keeps
 * distinct concurrent sources within the cap, including on standalone MongoDB.
 */
export async function awardXpBatchWithDailyCap(
  studentId,
  sourceType,
  items,
  cap,
  baseMeta = {},
) {
  await ensureXpIndexes()
  const student = objectId(studentId)
  let xpEarned = 0
  const awardedItems = []

  for (const item of items) {
    const amount = Math.max(0, Math.round(Number(item.amount) || 0))
    if (!amount) continue

    const existing = await existingXpEvent(student, sourceType, item.sourceId)
    if (existing) continue

    const reservation = await reserveDailyXp(
      student,
      sourceType,
      item.sourceId,
      amount,
      Math.max(0, Number(cap) || 0),
    )
    if (!reservation.allowed) break

    let result
    try {
      result = await awardXp(
        student,
        sourceType,
        item.sourceId,
        reservation.amount,
        { ...baseMeta, ...(item.meta || {}) },
        { quotaDay: reservation.day },
      )
    } catch (error) {
      const recorded = await existingXpEvent(student, sourceType, item.sourceId)
      if (!recorded) {
        await XpQuota.updateOne(
          { student, sourceType, day: reservation.day, 'reservations.sourceId': String(item.sourceId) },
          {
            $inc: { used: -reservation.amount },
            $pull: { reservations: { sourceId: String(item.sourceId) } },
          },
        )
      }
      throw error
    }
    if (result.awarded) {
      xpEarned += result.amount
      awardedItems.push({ ...item, amount: result.amount })
    } else if (result.amount > 0) {
      // A concurrent award may have inserted this source after our pre-check.
      // Keep its original reservation as consumed and report the recorded amount.
      awardedItems.push({ ...item, amount: result.amount, replayed: true })
    }
  }

  return { xpEarned, awardedItems }
}

export async function awardXp(studentId, sourceType, sourceId, amount, meta = {}, options = {}) {
  const rounded = Math.max(0, Math.round(Number(amount) || 0))
  if (!rounded) return { awarded: false, amount: 0 }
  await ensureXpIndexes()
  const student = objectId(studentId)
  const source = String(sourceId)
  try {
    await XpEvent.create({
      student,
      sourceType,
      sourceId: source,
      amount: rounded,
      meta,
      ...(options.quotaDay ? { quotaDay: options.quotaDay } : {}),
      ...(options.createdAt ? { createdAt: options.createdAt } : {}),
    })
    return { awarded: true, amount: rounded }
  } catch (err) {
    // Return the immutable recorded amount so callers can repair snapshots on replay.
    if (err?.code === 11000) {
      const existing = await existingXpEvent(student, sourceType, source)
      return { awarded: false, amount: existing?.amount || 0 }
    }
    throw err
  }
}

async function sumXp(studentId, filter = {}) {
  const [row] = await XpEvent.aggregate([
    { $match: { student: objectId(studentId), ...filter } },
    { $group: { _id: null, total: { $sum: '$amount' } } },
  ])
  return row?.total || 0
}

async function upsertReward({
  student,
  source,
  sourceRef,
  rewardType,
  rewardKey = '',
  amount = 0,
  meta = {},
}) {
  const result = await RewardGrant.updateOne(
    {
      student,
      source,
      sourceRef: String(sourceRef),
      rewardType,
      rewardKey: rewardKey || '',
    },
    { $setOnInsert: { amount: Math.max(0, Number(amount) || 0), meta } },
    { upsert: true },
  )
  return result.upsertedCount > 0
}

async function ensureActivityBadges(student) {
  const granted = []
  const [questCount, gameCount, gameKeys] = await Promise.all([
    DailyQuest.countDocuments({ student, reward: 1 }),
    GameResult.countDocuments({ student }),
    GameResult.distinct('gameKey', { student }),
  ])

  const badge = async (key) => {
    const created = await upsertReward({
      student,
      source: 'badge',
      sourceRef: key,
      rewardType: 'badge',
      rewardKey: key,
      meta: { key },
    })
    if (created) granted.push(key)
  }

  if (questCount >= 1) await badge('first_quest')
  if (questCount >= 7) await badge('quest_explorer')
  if (gameCount >= 1) await badge('first_game')
  if (gameKeys.length >= 4) await badge('game_explorer')
  return granted
}

/**
 * Recompute the cached profile from the immutable XP ledger, then grant any
 * rewards for levels crossed since the last reconciliation. All writes are
 * idempotent because RewardGrant has a unique activity/source/reward key.
 */
export async function reconcileGamification(studentId) {
  const student = objectId(studentId)
  const rules = await getLevelRules()
  const totalXp = await sumXp(student)
  const currentRule = levelForXp(totalXp, rules)

  let profile = await GamificationProfile.findOne({ student })
  const profileWasMissing = !profile
  const previousHighest = profile?.highestLevel ?? 0

  if (!profile) {
    profile = new GamificationProfile({
      student,
      totalXp: 0,
      level: currentRule.level,
      highestLevel: 0,
    })
  }

  const newRewards = []
  const startLevel = previousHighest > 0 ? previousHighest + 1 : 1
  for (let level = startLevel; level <= currentRule.level; level += 1) {
    const rule = rules.find((item) => item.level === level)
    if (!rule) continue
    for (const reward of rule.rewards || []) {
      // Badges are reconciled for every reached level below, so they are not
      // granted twice here.
      if (reward.type === 'badge') continue
      const created = await upsertReward({
        student,
        source: 'level',
        sourceRef: level,
        rewardType: reward.type,
        rewardKey: reward.key,
        amount: reward.amount,
        meta: { level },
      })
      if (created) newRewards.push({ ...reward, level })
    }
  }

  const newBadges = []
  for (const rule of rules) {
    if (rule.level > currentRule.level) break
    for (const reward of rule.rewards || []) {
      if (reward.type !== 'badge') continue
      const created = await upsertReward({
        student,
        source: 'level',
        sourceRef: rule.level,
        rewardType: 'badge',
        rewardKey: reward.key,
        meta: { level: rule.level },
      })
      if (created) newBadges.push(reward.key)
    }
  }
  newBadges.push(...(await ensureActivityBadges(student)))

  profile.totalXp = totalXp
  profile.level = currentRule.level
  if (currentRule.level > profile.highestLevel) {
    profile.highestLevel = currentRule.level
    profile.lastLevelUpAt = new Date()
  }
  try {
    await profile.save()
  } catch (err) {
    // Concurrent first-time reconciliation can race on the unique student key.
    if (err?.code === 11000 && profileWasMissing) {
      return reconcileGamification(studentId)
    }
    throw err
  }

  const progress = levelProgress(totalXp, currentRule, rules)
  return {
    totalXp,
    level: currentRule.level,
    levelName: currentRule.name,
    ...progress,
    levelUp:
      previousHighest > 0 && currentRule.level > previousHighest
        ? { from: previousHighest, to: currentRule.level }
        : null,
    newRewards,
    newBadges: [...new Set(newBadges)],
  }
}

export async function getFireflyBalance(studentId) {
  const student = objectId(studentId)
  const [questCount, rewardRows] = await Promise.all([
    DailyQuest.countDocuments({ student, reward: 1 }),
    RewardGrant.aggregate([
      { $match: { student, rewardType: 'firefly' } },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ]),
  ])
  return questCount + (rewardRows[0]?.total || 0)
}

export async function getGamificationSummary(studentId, { sync = true } = {}) {
  const student = objectId(studentId)
  const now = new Date()

  if (sync) await reconcileGamification(studentId)

  const [profile, rules, fireflies, badgeRows, todayXp, weekXp] = await Promise.all([
    GamificationProfile.findOne({ student }).lean(),
    getLevelRules(),
    getFireflyBalance(studentId),
    RewardGrant.find({ student, rewardType: 'badge' })
      .select('rewardKey createdAt')
      .sort({ createdAt: 1 })
      .lean(),
    // Backfill represents historical progress, not activity earned today or
    // this week. It still counts toward totalXp/level, just not these panels.
    sumXp(student, {
      sourceType: { $ne: 'backfill' },
      $or: [
        { quotaDay: { $gte: dayKey(now, TIMEZONE) } },
        { $and: [{ quotaDay: null }, { createdAt: { $gte: dayBoundary(now, 0, TIMEZONE) } }] },
      ],
    }),
    sumXp(student, {
      sourceType: { $ne: 'backfill' },
      $or: [
        { quotaDay: { $gte: dayKey(new Date(dayBoundary(now, -6, TIMEZONE)), TIMEZONE) } },
        { $and: [{ quotaDay: null }, { createdAt: { $gte: dayBoundary(now, -6, TIMEZONE) } }] },
      ],
    }),
  ])

  const totalXp = profile?.totalXp ?? (await sumXp(student))
  const currentRule = levelForXp(totalXp, rules)
  const progress = levelProgress(totalXp, currentRule, rules)

  return {
    totalXp,
    level: currentRule.level,
    levelName: currentRule.name,
    ...progress,
    todayXp,
    weekXp,
    fireflies,
    badges: badgeRows.map((row) => ({
      key: row.rewardKey,
      earnedAt: row.createdAt,
    })),
  }
}

export function gameAccuracy(gameKey, correct, total, meta = {}) {
  const safeTotal = Math.max(1, Number(total) || 0)
  if (gameKey === 'matching') {
    const attempts = Math.max(safeTotal, Number(meta.attempts) || safeTotal)
    return Math.max(0, Math.min(1, safeTotal / attempts))
  }
  return Math.max(0, Math.min(1, (Number(correct) || 0) / safeTotal))
}

export function computeGameXp(gameKey, correct, total, meta = {}) {
  const accuracy = gameAccuracy(gameKey, correct, total, meta)
  return Math.min(
    XP_RULES.gameBase + XP_RULES.gameAccuracyMax,
    XP_RULES.gameBase + Math.round(XP_RULES.gameAccuracyMax * accuracy),
  )
}

export async function awardGameXp(studentId, sessionId, gameKey, correct, total, meta = {}) {
  const student = objectId(studentId)
  const sourceId = String(sessionId)
  const existing = await existingXpEvent(student, 'game', sourceId)
  let xpEarned = existing?.amount || 0

  if (!existing) {
    const result = await awardXpBatchWithDailyCap(
      student,
      'game',
      [{ sourceId, amount: computeGameXp(gameKey, correct, total, meta) }],
      XP_RULES.gameDailyCap,
      { gameKey, correct, total, ...meta },
    )
    xpEarned = result.xpEarned
    // A concurrent replay can win the unique source insert after our pre-check.
    if (!xpEarned) {
      const recorded = await existingXpEvent(student, 'game', sourceId)
      xpEarned = recorded?.amount || 0
    }
  }

  const state = await reconcileGamification(studentId)
  return { ...state, xpEarned }
}

export async function awardDailyQuestXp(studentId, quest) {
  // The backfill event already includes every quest completed before the
  // migration. Re-opening one of those historical quests must not mint a
  // second +20 XP event.
  const backfill = await XpEvent.findOne({
    student: objectId(studentId),
    sourceType: 'backfill',
    sourceId: 'v1',
  })
    .select('createdAt')
    .lean()
  if (
    backfill &&
    quest.completedAt &&
    new Date(quest.completedAt).getTime() < new Date(backfill.createdAt).getTime()
  ) {
    const state = await reconcileGamification(studentId)
    return { ...state, xpEarned: 0 }
  }

  // Each revealed letter costs a little XP; a fully hinted quest still pays a
  // small completion reward.
  const amount = questXpReward(quest.revealed)
  const awarded = await awardXp(studentId, 'daily_quest', String(quest._id), amount, {
    day: quest.day,
    hints: quest.revealed?.length || 0,
  })
  const state = await reconcileGamification(studentId)
  return {
    ...state,
    xpEarned: awarded.awarded ? amount : 0,
  }
}

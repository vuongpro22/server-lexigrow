import 'dotenv/config'
import mongoose from 'mongoose'
import { requireIsolatedTestExecution } from './localTestDatabaseGuard.js'

requireIsolatedTestExecution('backfillGamification', {
  envFlag: 'RUN_BACKFILL_GAMIFICATION',
})
import connectDB from '../src/config/db.js'
import DailyQuest from '../src/models/DailyQuest.js'
import Essay from '../src/models/Essay.js'
import GamificationProfile from '../src/models/GamificationProfile.js'
import RewardGrant from '../src/models/RewardGrant.js'
import Vocabulary from '../src/models/Vocabulary.js'
import XpEvent from '../src/models/XpEvent.js'
import { ensureDefaultLevelRules, getLevelRules, levelForXp, reconcileGamification } from '../src/services/gamification.service.js'

const XP_PER_VOCAB = 10
const XP_PER_ESSAY = 50
const XP_PER_QUEST = 20

function mergeCounts(target, rows) {
  for (const row of rows) {
    const id = String(row._id)
    target.set(id, (target.get(id) || 0) + row.count)
  }
}

async function main() {
  await connectDB()
  await Promise.all([
    XpEvent.init(),
    RewardGrant.init(),
    GamificationProfile.init(),
    DailyQuest.init(),
  ])
  await ensureDefaultLevelRules()
  const rules = await getLevelRules()

  const [vocabRows, essayRows, questRows] = await Promise.all([
    Vocabulary.aggregate([
      { $match: { student: { $ne: null } } },
      { $group: { _id: '$student', count: { $sum: 1 } } },
    ]),
    Essay.aggregate([
      { $match: { student: { $ne: null }, status: { $ne: 'draft' } } },
      { $group: { _id: '$student', count: { $sum: 1 } } },
    ]),
    DailyQuest.aggregate([
      { $match: { student: { $ne: null }, reward: 1 } },
      { $group: { _id: '$student', count: { $sum: 1 } } },
    ]),
  ])

  const scores = new Map()
  mergeCounts(scores, vocabRows.map((row) => ({ _id: row._id, count: row.count * XP_PER_VOCAB })))
  mergeCounts(scores, essayRows.map((row) => ({ _id: row._id, count: row.count * XP_PER_ESSAY })))
  mergeCounts(scores, questRows.map((row) => ({ _id: row._id, count: row.count * XP_PER_QUEST })))

  let migrated = 0
  for (const [studentId, totalXp] of scores) {
    if (!studentId) continue
    const level = levelForXp(totalXp, rules)
    await XpEvent.updateOne(
      { student: studentId, sourceType: 'backfill', sourceId: 'v1' },
      {
        $setOnInsert: {
          student: studentId,
          sourceType: 'backfill',
          sourceId: 'v1',
          amount: totalXp,
          meta: { vocabRows: vocabRows.length, essayRows: essayRows.length, questRows: questRows.length },
        },
      },
      { upsert: true },
    )
    await GamificationProfile.updateOne(
      { student: studentId },
      {
        $set: { totalXp, level: level.level },
        $max: { highestLevel: level.level },
      },
      { upsert: true },
    )
    // Reconcile level badges and activity badges. Because highestLevel was set
    // to the current level, historical firefly rewards are not granted.
    await reconcileGamification(studentId)
    migrated += 1
  }

  console.log(`Backfilled gamification profiles: ${migrated}`)
  await mongoose.disconnect()
}

main().catch(async (err) => {
  console.error(err)
  await mongoose.disconnect().catch(() => {})
  process.exitCode = 1
})

import 'dotenv/config'
import mongoose from 'mongoose'
import { requireIsolatedTestExecution } from './localTestDatabaseGuard.js'

requireIsolatedTestExecution('seedGamification', {
  envFlag: 'RUN_SEED_GAMIFICATION',
})
import connectDB from '../src/config/db.js'
import { ensureDefaultLevelRules } from '../src/services/gamification.service.js'
import LevelRule from '../src/models/LevelRule.js'

async function main() {
  await connectDB()
  await LevelRule.init()
  await ensureDefaultLevelRules()
  const count = await LevelRule.countDocuments()
  console.log(`Gamification level rules ready: ${count}`)
  await mongoose.disconnect()
}

main().catch(async (err) => {
  console.error(err)
  await mongoose.disconnect().catch(() => {})
  process.exitCode = 1
})

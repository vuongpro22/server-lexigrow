import dotenv from 'dotenv'
import path from 'path'
import { fileURLToPath } from 'url'
import { requireIsolatedTestExecution } from './localTestDatabaseGuard.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(__dirname, '../.env') })

requireIsolatedTestExecution('seedLearningSets', {
  envFlag: 'RUN_SEED_LEARNING_SETS',
})

import connectDB from '../src/config/db.js'
import defaultLearningSets from '../src/data/defaultLearningSets.js'
import { seedDefaultData } from '../src/services/seedBootstrap.service.js'

async function seedLearningSets() {
  try {
    await connectDB()
    console.log('Connected to MongoDB')

    const { learningSets } = await seedDefaultData({ learningSets: defaultLearningSets, pricingPlans: [] })
    console.log(`Seed completed: ${learningSets.inserted} inserted, ${learningSets.preserved} existing sets preserved.`)
    process.exit(0)
  } catch (error) {
    console.error('Seed failed:', error)
    process.exit(1)
  }
}

seedLearningSets()
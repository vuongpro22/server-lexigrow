import dotenv from 'dotenv'
import path from 'path'
import { fileURLToPath } from 'url'
import { requireIsolatedTestExecution } from './localTestDatabaseGuard.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(__dirname, '../.env') })

requireIsolatedTestExecution('seedPricingPlans', {
  envFlag: 'RUN_SEED_PRICING_PLANS',
})

import connectDB from '../src/config/db.js'
import { defaultPricingPlans } from '../src/data/defaultPricingPlans.js'
import { seedDefaultData } from '../src/services/seedBootstrap.service.js'

async function seedPlans() {
  try {
    console.log('Connecting to MongoDB...')
    await connectDB()
    const { pricingPlans } = await seedDefaultData({ learningSets: [], pricingPlans: defaultPricingPlans })
    console.log(`Seeded ${defaultPricingPlans.length} subscription plans: ${pricingPlans.inserted} inserted, ${pricingPlans.preserved} kept existing.`)
    process.exit(0)
  } catch (err) {
    console.error('Error seeding plans:', err)
    process.exit(1)
  }
}

seedPlans()

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { MongoMemoryServer } from 'mongodb-memory-server'
import mongoose from 'mongoose'
import LearningSet from '../src/models/LearningSet.js'
import SubscriptionPlan from '../src/models/SubscriptionPlan.js'
import { seedDefaultData } from '../src/services/seedBootstrap.service.js'
import defaultLearningSets from '../src/data/defaultLearningSets.js'
import { defaultPricingPlans } from '../src/data/defaultPricingPlans.js'

let mongo
beforeAll(async () => {
  mongo = await MongoMemoryServer.create()
  await mongoose.connect(mongo.getUri())
}, 180000)
afterAll(async () => {
  await mongoose.disconnect()
  await mongo?.stop()
})
beforeEach(async () => {
  await Promise.all([LearningSet.deleteMany({}), SubscriptionPlan.deleteMany({})])
})

describe('DEP-01 default data bootstrap', () => {
  it('inserts the learning sets and pricing plans on an empty database', async () => {
    const result = await seedDefaultData()
    expect(result.learningSets.inserted).toBe(defaultLearningSets.length)
    expect(result.pricingPlans.inserted).toBe(defaultPricingPlans.length)
    expect(await LearningSet.countDocuments()).toBe(defaultLearningSets.length)
    expect(await SubscriptionPlan.countDocuments()).toBe(defaultPricingPlans.length)
  })

  it('is idempotent on a second run', async () => {
    await seedDefaultData()
    const second = await seedDefaultData()
    expect(second.learningSets.inserted).toBe(0)
    expect(second.pricingPlans.inserted).toBe(0)
    expect(second.learningSets.preserved).toBe(defaultLearningSets.length)
  })

  it('never overwrites rows an admin already edited', async () => {
    await LearningSet.create({ ...defaultLearningSets[0], title: 'Admin renamed this' })
    await seedDefaultData()
    const set = await LearningSet.findOne({ slug: defaultLearningSets[0].slug })
    expect(set.title).toBe('Admin renamed this')
    expect(await LearningSet.countDocuments()).toBe(defaultLearningSets.length)
  })

  it('keeps the shipped data aligned between the bootstrap and the standalone seed', async () => {
    expect(defaultLearningSets.every((set) => set.slug && set.items?.length)).toBe(true)
    expect(defaultPricingPlans.every((plan) => plan.slug && plan.targetRole)).toBe(true)
  })
})

import LearningSet from '../models/LearningSet.js'
import SubscriptionPlan from '../models/SubscriptionPlan.js'
import defaultLearningSets from '../data/defaultLearningSets.js'
import { defaultPricingPlans } from '../data/defaultPricingPlans.js'

async function upsertByIdentity(Model, docs, identity) {
  let inserted = 0
  for (const doc of docs) {
    const result = await Model.updateOne(
      { [identity]: doc[identity] },
      { $setOnInsert: doc },
      { upsert: true },
    )
    inserted += result.upsertedCount || 0
  }
  return { checked: docs.length, inserted, preserved: docs.length - inserted }
}

// $setOnInsert only: rows an admin or teacher already edited are never overwritten.
export async function seedDefaultData({ learningSets = defaultLearningSets, pricingPlans = defaultPricingPlans } = {}) {
  const [sets, plans] = await Promise.all([
    upsertByIdentity(LearningSet, learningSets, 'slug'),
    upsertByIdentity(SubscriptionPlan, pricingPlans, 'slug'),
  ])
  return { learningSets: sets, pricingPlans: plans }
}

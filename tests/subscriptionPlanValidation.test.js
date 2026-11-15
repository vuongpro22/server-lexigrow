import { describe, expect, it } from 'vitest'
import SubscriptionPlan from '../src/models/SubscriptionPlan.js'

const base = () => ({
  slug: 'teacher-check', name: 'Teacher Check', targetRole: 'teacher', tier: 'plus',
  monthlyPrice: 1000, yearlyPrice: 10000,
})

describe('subscription plan limits', () => {
  it.each(['maxSponsoredStudents', 'maxClasses', 'dailyAiEssayLimit'])('rejects an invalid negative %s', (field) => {
    const plan = new SubscriptionPlan({ ...base(), [field]: -2 })
    expect(plan.validateSync()?.errors[field]).toBeDefined()
  })

  it('allows -1 only for unlimited daily AI essays', () => {
    const plan = new SubscriptionPlan({ ...base(), dailyAiEssayLimit: -1 })
    expect(plan.validateSync()).toBeUndefined()
  })
})

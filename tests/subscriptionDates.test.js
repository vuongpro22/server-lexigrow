import { describe, expect, it } from 'vitest'
import { renewalEndDate } from '../src/utils/subscriptionDates.js'

describe('early subscription renewals', () => {
  it('keeps paid time remaining before adding the next cycle', () => {
    const paidAt = new Date('2026-11-04T00:00:00Z')
    const oldExpiry = new Date('2026-11-24T00:00:00Z')
    expect(renewalEndDate(paidAt, oldExpiry, 30).toISOString()).toBe('2026-12-24T00:00:00.000Z')
  })

  it('starts a new cycle today when the previous one has expired', () => {
    const paidAt = new Date('2026-11-04T00:00:00Z')
    expect(renewalEndDate(paidAt, new Date('2026-11-01T00:00:00Z'), 30).toISOString()).toBe('2026-12-04T00:00:00.000Z')
  })
})

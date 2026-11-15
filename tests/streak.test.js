import { describe, it, expect } from 'vitest'
import { calculateStreak } from '../src/utils/streak.js'

describe('streak calculation', () => {
  const now = new Date('2026-11-04T03:00:00Z') // 10:00 in Vietnam

  it('counts consecutive days ending today', () => {
    const result = calculateStreak(['2026-11-02', '2026-11-03', '2026-11-04'], now)
    expect(result.streakDays).toBe(3)
    expect(result.hasActivityToday).toBe(true)
  })

  it('allows a streak ending yesterday', () => {
    const result = calculateStreak(['2026-11-01', '2026-11-02', '2026-11-03'], now)
    expect(result.streakDays).toBe(3)
    expect(result.hasActivityToday).toBe(false)
  })

  it('returns zero when the last activity is older than yesterday', () => {
    const result = calculateStreak(['2026-10-30', '2026-10-31'], now)
    expect(result.streakDays).toBe(0)
  })

  it('deduplicates multiple activities on the same day', () => {
    const result = calculateStreak(['2026-11-04', '2026-11-04', '2026-11-03'], now)
    expect(result.streakDays).toBe(2)
  })

  it('ignores future activity dates and preserves current streak', () => {
    const result = calculateStreak(['2026-11-03', '2026-11-04', '2026-11-10'], now)
    expect(result.streakDays).toBe(2)
    expect(result.hasActivityToday).toBe(true)
    expect(result.lastActivityDate).toBe('2026-11-04')
  })
})

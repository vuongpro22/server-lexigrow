import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  bucketFindOneAndUpdate: vi.fn(),
  bucketFindOne: vi.fn(),
  bucketUpdateOne: vi.fn(),
  essayCount: vi.fn(),
  revisionCount: vi.fn(),
  tier: vi.fn(),
}))
vi.mock('../src/models/AIQuotaBucket.js', () => ({ default: {
  findOneAndUpdate: mocks.bucketFindOneAndUpdate,
  findOne: mocks.bucketFindOne,
  updateOne: mocks.bucketUpdateOne,
} }))
vi.mock('../src/models/Essay.js', () => ({ default: { countDocuments: mocks.essayCount } }))
vi.mock('../src/models/EssayRevision.js', () => ({ default: { countDocuments: mocks.revisionCount } }))
vi.mock('../src/services/tier.service.js', () => ({ getUserEffectiveTier: mocks.tier }))

import {
  checkDailyEssayQuota,
  consumeDailyEssayQuota,
  reserveDailyEssayQuota,
  settleDailyEssayQuota,
  settleHistoryQuota,
} from '../src/services/aiQuota.service.js'

const tierInfo = { tier: 'free', dailyAiEssayLimit: 3, isUnlimitedAi: false }
const bucket = (overrides = {}) => ({
  _id: 'bucket-1',
  student: 'student-1',
  day: '2026-11-10',
  legacyUsed: 0,
  consumed: 0,
  reserved: 0,
  reservations: [],
  ...overrides,
})
const resolution = (value) => ({ session: vi.fn().mockReturnThis(), sort: vi.fn().mockReturnThis(), then: (resolve) => Promise.resolve(value).then(resolve) })

beforeEach(() => {
  vi.resetAllMocks()
  mocks.tier.mockResolvedValue(tierInfo)
  mocks.essayCount.mockResolvedValue(0)
  mocks.revisionCount.mockResolvedValue(0)
  mocks.bucketFindOneAndUpdate.mockResolvedValue(bucket())
  mocks.bucketFindOne.mockReturnValue(resolution(null))
  mocks.bucketUpdateOne.mockResolvedValue({ modifiedCount: 1 })
})

describe('atomic AI daily quota ledger', () => {
  it('counts legacy submissions, revisions, consumed quota, and active reservations', async () => {
    mocks.essayCount.mockResolvedValue(1)
    mocks.revisionCount.mockResolvedValue(1)
    mocks.bucketFindOneAndUpdate.mockResolvedValue(bucket({ consumed: 1, reserved: 1, legacyUsed: 2 }))
    const quota = await checkDailyEssayQuota({ _id: 'student-1', role: 'student' }, new Date('2026-11-10T17:00:00Z'))
    expect(quota).toMatchObject({ canSubmit: false, usedToday: 4, remaining: 0 })
    expect(mocks.essayCount).toHaveBeenCalledWith(expect.objectContaining({ submittedAt: {
      $gte: new Date('2026-11-10T17:00:00Z'), $lt: new Date('2026-11-11T17:00:00Z'),
    } }))
    expect(mocks.revisionCount).toHaveBeenCalledWith(expect.objectContaining({ student: 'student-1', revisionNumber: { $gt: 1 } }))
  })

  it('reserves with an atomic capacity condition using the current day tier', async () => {
    mocks.bucketFindOneAndUpdate.mockResolvedValueOnce(bucket())
      .mockResolvedValueOnce(bucket({ reserved: 1, reservations: [{ requestId: 'request-1', state: 'reserved', kind: 'submission' }] }))
    const result = await reserveDailyEssayQuota({ student: 'student-1', requestId: 'request-1', kind: 'submission', now: new Date('2026-11-10T17:00:00Z') })
    expect(result).toMatchObject({ reserved: true, duplicate: false, day: '2026-11-11' })
    expect(mocks.bucketFindOneAndUpdate).toHaveBeenLastCalledWith(
      expect.objectContaining({ _id: 'bucket-1', $expr: expect.any(Object) }),
      { $inc: { reserved: 1 }, $push: { reservations: { requestId: 'request-1', state: 'reserved', kind: 'submission' } } },
      { returnDocument: 'after' },
    )
  })

  it('does not create a second reservation for a duplicate request id', async () => {
    mocks.bucketFindOne.mockReturnValueOnce(resolution(bucket()))
      .mockReturnValueOnce(resolution(bucket({ reserved: 1, reservations: [{ requestId: 'request-1', state: 'reserved', kind: 'revision' }] })))
    mocks.bucketFindOneAndUpdate.mockResolvedValueOnce(bucket({ reserved: 1, reservations: [{ requestId: 'request-1', state: 'reserved', kind: 'revision' }] }))
    mocks.bucketFindOneAndUpdate.mockResolvedValueOnce(null)
    const result = await reserveDailyEssayQuota({ student: 'student-1', requestId: 'request-1', kind: 'revision' })
    expect(result).toMatchObject({ reserved: true, duplicate: true, state: 'reserved' })
    expect(mocks.bucketFindOneAndUpdate).not.toHaveBeenCalled()
  })

  it('settles a reservation idempotently and only once', async () => {
    mocks.bucketFindOne.mockReturnValueOnce(resolution(bucket({ reserved: 1, reservations: [{ requestId: 'request-1', state: 'reserved', kind: 'submission' }] })))
    const result = await settleDailyEssayQuota({ student: 'student-1', requestId: 'request-1', day: '2026-11-10', outcome: 'consume' })
    expect(result).toMatchObject({ settled: true, duplicate: false, state: 'consumed' })
    expect(mocks.bucketUpdateOne).toHaveBeenCalledWith(
      { _id: 'bucket-1', reservations: { $elemMatch: { requestId: 'request-1', state: 'reserved' } } },
      { $inc: { reserved: -1, consumed: 1 }, $set: { 'reservations.$.state': 'consumed' } },
      {},
    )
  })

  it('releases a reservation on grading failure without consuming it', async () => {
    mocks.bucketFindOne.mockReturnValueOnce(resolution(bucket({ reserved: 1, reservations: [{ requestId: 'request-1', state: 'reserved', kind: 'revision' }] })))
    const result = await settleDailyEssayQuota({ student: 'student-1', requestId: 'request-1', day: '2026-11-10', outcome: 'release' })
    expect(result).toMatchObject({ settled: true, state: 'released' })
    expect(mocks.bucketUpdateOne).toHaveBeenCalledWith(expect.any(Object), {
      $inc: { reserved: -1 }, $set: { 'reservations.$.state': 'released' },
    }, {})
  })

  it('settles history payload by reservation ID and quota day', async () => {
    mocks.bucketFindOne.mockReturnValueOnce(resolution(bucket({ reserved: 1, reservations: [{ requestId: 'quota-key', state: 'reserved', kind: 'revision' }] })))
    const result = await settleHistoryQuota({ quota: { student: 'student-1', requestId: 'quota-key', day: '2026-11-10', outcome: 'consume' } })
    expect(result).toMatchObject({ settled: true, state: 'consumed' })
    expect(mocks.bucketFindOne).toHaveBeenCalledWith({ student: 'student-1', day: '2026-11-10' })
  })

  describe('consumeDailyEssayQuota (Task 2.2)', () => {
    it('atomically consumes quota with findOneAndUpdate when under limit', async () => {
      mocks.bucketFindOneAndUpdate
        .mockResolvedValueOnce(bucket()) // ensureBucket
        .mockResolvedValueOnce(bucket({ consumed: 1, used: 1 })) // atomic consume

      const result = await consumeDailyEssayQuota('student-1', { now: new Date('2026-11-10T17:00:00Z') })

      expect(result).toMatchObject({
        allowed: true,
        consumed: true,
        usedToday: 1,
        limit: 3,
        remaining: 2,
      })
      expect(mocks.bucketFindOneAndUpdate).toHaveBeenLastCalledWith(
        expect.objectContaining({ _id: 'bucket-1', $expr: expect.any(Object) }),
        { $inc: { consumed: 1, used: 1 } },
        { returnDocument: 'after' },
      )
    })

    it('rejects consumption when daily quota limit is reached (returns allowed: false)', async () => {
      mocks.bucketFindOne.mockReturnValueOnce(resolution(bucket({ consumed: 3, used: 3 })))
      mocks.bucketFindOneAndUpdate.mockResolvedValueOnce(null) // atomic consume fails because limit reached
      mocks.bucketFindOne.mockReturnValueOnce(resolution(bucket({ consumed: 3, used: 3 })))

      const result = await consumeDailyEssayQuota('student-1', { now: new Date('2026-11-10T17:00:00Z') })

      expect(result).toMatchObject({
        allowed: false,
        consumed: false,
        usedToday: 3,
        limit: 3,
        remaining: 0,
      })
    })

    it('allows unlimited AI for paid tiers without touching the bucket', async () => {
      mocks.tier.mockResolvedValueOnce({ tier: 'premium', dailyAiEssayLimit: 9999, isUnlimitedAi: true })

      const result = await consumeDailyEssayQuota('student-1')

      expect(result).toMatchObject({
        allowed: true,
        consumed: true,
        unlimited: true,
        remaining: 9999,
      })
      expect(mocks.bucketFindOneAndUpdate).not.toHaveBeenCalled()
    })

    it('records requestId in reservations array when provided', async () => {
      mocks.bucketFindOneAndUpdate
        .mockResolvedValueOnce(bucket()) // ensureBucket
        .mockResolvedValueOnce(bucket({ consumed: 1, used: 1, reservations: [{ requestId: 'req-1', state: 'consumed', kind: 'submission' }] }))

      const result = await consumeDailyEssayQuota('student-1', {
        now: new Date('2026-11-10T17:00:00Z'),
        requestId: 'req-1',
        kind: 'submission',
      })

      expect(result.allowed).toBe(true)
      expect(mocks.bucketFindOneAndUpdate).toHaveBeenLastCalledWith(
        expect.objectContaining({ _id: 'bucket-1' }),
        {
          $inc: { consumed: 1, used: 1 },
          $push: { reservations: { requestId: 'req-1', state: 'consumed', kind: 'submission' } },
        },
        { returnDocument: 'after' },
      )
    })
  })
})

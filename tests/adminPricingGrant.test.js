import { vi, describe, it, expect, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  userFindById: vi.fn(),
  userFindOne: vi.fn(),
  planFindOne: vi.fn(),
  planFindById: vi.fn(),
  planCreate: vi.fn(),
  subscriptionCreate: vi.fn(),
  subscriptionUpdateMany: vi.fn(),
  transactionCountDocuments: vi.fn(),
  logAction: vi.fn(),
}))

vi.mock('../src/models/User.js', () => ({
  default: {
    findById: (...a) => mocks.userFindById(...a),
    findOne: (...a) => mocks.userFindOne(...a),
  },
}))

vi.mock('../src/models/SubscriptionPlan.js', () => ({
  default: {
    findOne: (...a) => mocks.planFindOne(...a),
    findById: (...a) => mocks.planFindById(...a),
    create: (...a) => mocks.planCreate(...a),
    find: vi.fn(),
  },
}))

vi.mock('../src/models/Subscription.js', () => ({
  default: {
    create: (...a) => mocks.subscriptionCreate(...a),
    findOne: vi.fn().mockResolvedValue(null),
    exists: vi.fn().mockResolvedValue(false),
    updateMany: (...a) => mocks.subscriptionUpdateMany(...a),
    countDocuments: vi.fn(),
  },
}))

vi.mock('../src/models/PaymentTransaction.js', () => ({
  default: {
    countDocuments: (...a) => mocks.transactionCountDocuments(...a),
  },
}))

vi.mock('../src/utils/auditLogger.js', () => ({
  logAction: (...a) => mocks.logAction(...a),
}))

import {
  adminGrantSubscription,
  adminCreatePlan,
} from '../src/controllers/admin.pricing.controller.js'
import Subscription from '../src/models/Subscription.js'

const mockRes = () => ({
  status: vi.fn().mockReturnThis(),
  json: vi.fn(),
})

const mockReq = (body, headers = {}) => ({
  body,
  user: { _id: 'admin_1', email: 'admin@example.com', role: 'admin' },
  // Real Express requests always expose req.get(name); the grant handler reads
  // the Idempotency-Key header through it.
  get: (name) => headers[String(name).toLowerCase()],
})

const VALID_PLAN = {
  _id: 'plan_1',
  slug: 'pro',
  targetRole: 'student',
  tier: 'pro',
  maxSponsoredStudents: 0,
  isActive: true,
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.subscriptionCreate.mockResolvedValue({ _id: 'sub_1' })
  mocks.subscriptionUpdateMany.mockResolvedValue({ modifiedCount: 0 })
  Subscription.findOne.mockResolvedValue(null)
  mocks.logAction.mockResolvedValue(undefined)
})

describe('adminGrantSubscription — userId may be an ObjectId or an email', () => {
  it('resolves a 24-hex ObjectId with findById only', async () => {
    const objectId = '507f1f77bcf86cd799439011'
    mocks.userFindById.mockResolvedValue({ _id: objectId, email: 'student@example.com', role: 'student', accountStatus: 'active' })
    mocks.planFindOne.mockResolvedValue(VALID_PLAN)

    const req = mockReq({ userId: objectId, planSlug: 'pro', durationDays: 30 })
    const res = mockRes()
    const next = vi.fn()

    await adminGrantSubscription(req, res, next)

    expect(next).not.toHaveBeenCalled()
    expect(mocks.userFindById).toHaveBeenCalledWith(objectId)
    expect(mocks.userFindOne).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(201)
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true, data: { _id: 'sub_1' } })
    )
    expect(mocks.subscriptionCreate).toHaveBeenCalledWith(
      expect.objectContaining({ user: objectId, planSlug: 'pro' })
    )
  })

  it('resolves an email with a lowercased findOne and no findById', async () => {
    mocks.userFindOne.mockResolvedValue({ _id: 'user_1', email: 'student@example.com', role: 'student', accountStatus: 'active' })
    mocks.planFindOne.mockResolvedValue(VALID_PLAN)

    const req = mockReq({ userId: 'Student@Example.com', planSlug: 'pro' })
    const res = mockRes()
    const next = vi.fn()

    await adminGrantSubscription(req, res, next)

    expect(next).not.toHaveBeenCalled()
    expect(mocks.userFindById).not.toHaveBeenCalled()
    expect(mocks.userFindOne).toHaveBeenCalledWith({ email: 'student@example.com' })
    expect(res.status).toHaveBeenCalledWith(201)
    expect(mocks.subscriptionCreate).toHaveBeenCalledWith(
      expect.objectContaining({ user: 'user_1' })
    )
  })

  it('responds 404 when neither lookup finds a user', async () => {
    mocks.userFindOne.mockResolvedValue(null)

    const req = mockReq({ userId: 'ghost@example.com', planSlug: 'pro' })
    const res = mockRes()
    const next = vi.fn()

    await adminGrantSubscription(req, res, next)

    expect(res.status).not.toHaveBeenCalled()
    expect(next).toHaveBeenCalledTimes(1)
    expect(next.mock.calls[0][0].statusCode).toBe(404)
    expect(mocks.subscriptionCreate).not.toHaveBeenCalled()
  })

  it('never passes a malformed short string to findById (avoids CastError)', async () => {
    mocks.userFindOne.mockResolvedValue(null)

    const req = mockReq({ userId: 'abc', planSlug: 'pro' })
    const res = mockRes()
    const next = vi.fn()

    await adminGrantSubscription(req, res, next)

    expect(mocks.userFindById).not.toHaveBeenCalled()
    expect(mocks.userFindOne).toHaveBeenCalledWith({ email: 'abc' })
    expect(res.status).not.toHaveBeenCalled()
    expect(next).toHaveBeenCalledTimes(1)
    expect(next.mock.calls[0][0].statusCode).toBe(404)
  })

  it('refuses to replace an active paid subscription', async () => {
    mocks.userFindOne.mockResolvedValue({ _id: 'user_1', email: 'student@example.com', role: 'student', accountStatus: 'active' })
    mocks.planFindOne.mockResolvedValue(VALID_PLAN)
    Subscription.findOne.mockResolvedValue({ _id: 'paid_1', amountPaid: 100000 })
    const next = vi.fn()

    await adminGrantSubscription(mockReq({ userId: 'student@example.com', planSlug: 'pro' }), mockRes(), next)

    expect(next.mock.calls[0][0].statusCode).toBe(409)
    expect(mocks.subscriptionCreate).not.toHaveBeenCalled()
  })

  it('does not grant a plan to a suspended account', async () => {
    mocks.userFindOne.mockResolvedValue({ _id: 'user_1', email: 'student@example.com', role: 'student', accountStatus: 'suspended' })
    const next = vi.fn()

    await adminGrantSubscription(mockReq({ userId: 'student@example.com', planSlug: 'pro' }), mockRes(), next)

    expect(next.mock.calls[0][0].statusCode).toBe(400)
    expect(mocks.subscriptionCreate).not.toHaveBeenCalled()
  })

  it('extends from an existing active free subscription endDate instead of shortening it', async () => {
    const existingFutureEnd = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000)
    mocks.userFindOne.mockResolvedValue({ _id: 'user_1', email: 'student@example.com', role: 'student', accountStatus: 'active' })
    mocks.planFindOne.mockResolvedValue(VALID_PLAN)
    Subscription.findOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ _id: 'free_1', amountPaid: 0, endDate: existingFutureEnd })

    const res = mockRes()
    const next = vi.fn()

    await adminGrantSubscription(mockReq({ userId: 'student@example.com', planSlug: 'pro', durationDays: 30 }), res, next)

    expect(next).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(201)
    const createdDoc = mocks.subscriptionCreate.mock.calls[0][0]
    const expectedMinEnd = existingFutureEnd.getTime() + 30 * 24 * 60 * 60 * 1000 - 1000
    expect(createdDoc.endDate.getTime()).toBeGreaterThanOrEqual(expectedMinEnd)
  })
})

describe('adminCreatePlan — dailyAiEssayLimit defaults', () => {
  const baseBody = {
    slug: 'pro',
    name: 'Pro',
    targetRole: 'student',
    tier: 'pro',
    monthlyPrice: 99000,
    yearlyPrice: 990000,
  }

  const createPlan = async (overrides) => {
    mocks.planFindOne.mockResolvedValue(null)
    mocks.planCreate.mockImplementation(async (doc) => ({ _id: 'plan_new', ...doc }))

    const req = mockReq({ ...baseBody, ...overrides })
    const res = mockRes()
    const next = vi.fn()

    await adminCreatePlan(req, res, next)

    expect(next).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(201)
    return mocks.planCreate.mock.calls[0][0]
  }

  it('keeps an explicit 0 instead of coercing it to 3', async () => {
    const doc = await createPlan({ dailyAiEssayLimit: 0 })
    expect(doc.dailyAiEssayLimit).toBe(0)
  })

  it('falls back to 3 when the field is undefined', async () => {
    const doc = await createPlan({})
    expect(doc.dailyAiEssayLimit).toBe(3)
  })

  it("falls back to 3 when the field is an empty string", async () => {
    const doc = await createPlan({ dailyAiEssayLimit: '' })
    expect(doc.dailyAiEssayLimit).toBe(3)
  })
})

describe('adminGrantSubscription — Idempotency-Key replay', () => {
  it('returns the original grant instead of minting a second one', async () => {
    mocks.userFindOne.mockResolvedValue({ _id: 'user_1', email: 'student@example.com', role: 'student', accountStatus: 'active' })
    mocks.planFindOne.mockResolvedValue(VALID_PLAN)
    const earlier = { _id: 'sub_original', requestFingerprint: 'fingerprint' }
    const { createHash } = await import('node:crypto')
    earlier.requestFingerprint = createHash('sha256')
      .update(JSON.stringify({ actorId: 'admin_1', userId: 'user_1', planId: 'plan_1', days: 30 }))
      .digest('hex')
    Subscription.findOne.mockImplementation(async (query) => (query.idempotencyKey ? earlier : null))

    const req = mockReq({ userId: 'student@example.com', planSlug: 'pro' }, { 'idempotency-key': 'key-1' })
    const res = mockRes()
    const next = vi.fn()

    await adminGrantSubscription(req, res, next)

    expect(next).not.toHaveBeenCalled()
    expect(mocks.subscriptionCreate).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true, replayed: true, data: earlier })
    )
  })

  it('rejects a reused key when the grant payload differs', async () => {
    mocks.userFindOne.mockResolvedValue({ _id: 'user_2', email: 'other@example.com', role: 'student', accountStatus: 'active' })
    mocks.planFindOne.mockResolvedValue(VALID_PLAN)
    const earlier = { _id: 'sub_original', requestFingerprint: 'another-request' }
    Subscription.findOne.mockResolvedValue(earlier)
    const next = vi.fn()

    await adminGrantSubscription(mockReq({ userId: 'other@example.com', planSlug: 'pro', durationDays: 30 }, { 'idempotency-key': 'key-1' }), mockRes(), next)

    expect(next).toHaveBeenCalledTimes(1)
    expect(next.mock.calls[0][0].statusCode).toBe(409)
    expect(mocks.subscriptionCreate).not.toHaveBeenCalled()
  })

  it('survives a duplicate-key race by returning the request that won', async () => {
    mocks.userFindOne.mockResolvedValue({ _id: 'user_1', email: 'student@example.com', role: 'student', accountStatus: 'active' })
    mocks.planFindOne.mockResolvedValue(VALID_PLAN)
    const { createHash } = await import('node:crypto')
    const winner = {
      _id: 'sub_winner',
      requestFingerprint: createHash('sha256')
        .update(JSON.stringify({ actorId: 'admin_1', userId: 'user_1', planId: 'plan_1', days: 30 }))
        .digest('hex'),
    }

    let call = 0
    Subscription.findOne.mockImplementation(async (query) => {
      if (!query.idempotencyKey) return null
      call += 1
      return call === 1 ? null : winner
    })
    mocks.subscriptionCreate.mockRejectedValue(Object.assign(new Error('duplicate key'), { code: 11000 }))

    const req = mockReq({ userId: 'student@example.com', planSlug: 'pro' }, { 'idempotency-key': 'key-2' })
    const res = mockRes()
    const next = vi.fn()

    await adminGrantSubscription(req, res, next)

    expect(next).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ replayed: true, data: winner })
    )
  })

  it('stores the key on the created subscription', async () => {
    mocks.userFindOne.mockResolvedValue({ _id: 'user_1', email: 'student@example.com', role: 'student', accountStatus: 'active' })
    mocks.planFindOne.mockResolvedValue(VALID_PLAN)

    const req = mockReq({ userId: 'student@example.com', planSlug: 'pro' }, { 'idempotency-key': 'key-3' })
    const res = mockRes()
    const next = vi.fn()

    await adminGrantSubscription(req, res, next)

    expect(next).not.toHaveBeenCalled()
    expect(mocks.subscriptionCreate).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: 'key-3' })
    )
  })
})

describe('adminCreatePlan — numeric validation', () => {
  const baseBody = {
    slug: 'pro', name: 'Pro', targetRole: 'student', tier: 'pro',
    monthlyPrice: 99000, yearlyPrice: 990000,
  }

  it.each(['', '  '])('rejects an empty monthlyPrice (%j)', async (monthlyPrice) => {
    mocks.planFindOne.mockResolvedValue(null)
    const req = mockReq({ ...baseBody, monthlyPrice })
    const res = mockRes()
    const next = vi.fn()

    await adminCreatePlan(req, res, next)

    expect(next).toHaveBeenCalledTimes(1)
    expect(next.mock.calls[0][0].statusCode).toBe(400)
    expect(mocks.planCreate).not.toHaveBeenCalled()
  })

  it('rejects a non-numeric monthlyPrice instead of writing NaN', async () => {
    mocks.planFindOne.mockResolvedValue(null)
    const next = vi.fn()
    await adminCreatePlan(mockReq({ ...baseBody, monthlyPrice: 'abc' }), mockRes(), next)
    expect(next).toHaveBeenCalledTimes(1)
    expect(next.mock.calls[0][0].statusCode).toBe(400)
    expect(mocks.planCreate).not.toHaveBeenCalled()
  })

  it('rejects empty required price values', async () => {
    for (const field of ['monthlyPrice', 'yearlyPrice']) {
      mocks.planFindOne.mockResolvedValue(null)
      const next = vi.fn()
      await adminCreatePlan(mockReq({ ...baseBody, [field]: ' ' }), mockRes(), next)
      expect(next).toHaveBeenCalledTimes(1)
      expect(next.mock.calls[0][0].statusCode).toBe(400)
    }
    expect(mocks.planCreate).not.toHaveBeenCalled()
  })

  it('rejects fractional integer fields', async () => {
    for (const field of ['maxClasses', 'sortOrder', 'dailyAiEssayLimit', 'maxSponsoredStudents']) {
      mocks.planFindOne.mockResolvedValue(null)
      const next = vi.fn()
      await adminCreatePlan(mockReq({ ...baseBody, [field]: 1.5 }), mockRes(), next)
      expect(next).toHaveBeenCalledTimes(1)
      expect(next.mock.calls[0][0].statusCode).toBe(400)
    }
    expect(mocks.planCreate).not.toHaveBeenCalled()
  })

  it('rejects a fractional integer field when updating a plan', async () => {
    const plan = { _id: 'plan_1', sortOrder: 0, save: vi.fn() }
    mocks.planFindById.mockResolvedValue(plan)
    const next = vi.fn()
    const { adminUpdatePlan } = await import('../src/controllers/admin.pricing.controller.js')
    await adminUpdatePlan({ params: { id: 'plan_1' }, body: { sortOrder: 1.5 }, user: { _id: 'admin_1' } }, mockRes(), next)
    expect(next).toHaveBeenCalledTimes(1)
    expect(next.mock.calls[0][0].statusCode).toBe(400)
    expect(plan.save).not.toHaveBeenCalled()
  })

  it('rejects yearly price above twelve monthly payments', async () => {
    mocks.planFindOne.mockResolvedValue(null)
    const next = vi.fn()
    await adminCreatePlan(mockReq({ ...baseBody, yearlyPrice: 1188001 }), mockRes(), next)
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'YEARLY_PRICE_EXCEEDS_MONTHLY_TOTAL', statusCode: 400 }))
    expect(mocks.planCreate).not.toHaveBeenCalled()
  })

  it('rejects yearly price above twelve monthly payments when updating', async () => {
    const plan = { _id: 'plan_1', monthlyPrice: 99000, yearlyPrice: 900000, save: vi.fn() }
    mocks.planFindById.mockResolvedValue(plan)
    const next = vi.fn()
    const { adminUpdatePlan } = await import('../src/controllers/admin.pricing.controller.js')
    await adminUpdatePlan({ params: { id: 'plan_1' }, body: { yearlyPrice: 1188001 }, user: { _id: 'admin_1' } }, mockRes(), next)
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'YEARLY_PRICE_EXCEEDS_MONTHLY_TOTAL', statusCode: 400 }))
    expect(plan.save).not.toHaveBeenCalled()
  })

  it('rejects a non-numeric dailyAiEssayLimit', async () => {
    mocks.planFindOne.mockResolvedValue(null)
    const next = vi.fn()
    await adminCreatePlan(mockReq({ ...baseBody, dailyAiEssayLimit: 'many' }), mockRes(), next)
    expect(next).toHaveBeenCalledTimes(1)
    expect(next.mock.calls[0][0].statusCode).toBe(400)
  })

})


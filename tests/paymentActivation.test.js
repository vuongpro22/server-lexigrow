import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  transactionFindOne: vi.fn(),
  transactionClaim: vi.fn(),
  transactionUpdate: vi.fn(),
  planFindById: vi.fn(),
  subscriptionFindOne: vi.fn(),
  subscriptionCreate: vi.fn(),
  subscriptionUpdateMany: vi.fn(),
  startSession: vi.fn(),
  logAction: vi.fn(),
  createManyNotifications: vi.fn(),
}))

vi.mock('../src/models/PaymentTransaction.js', () => ({ default: {
  findOne: mocks.transactionFindOne,
  findOneAndUpdate: mocks.transactionClaim,
  updateOne: mocks.transactionUpdate,
} }))
vi.mock('../src/models/SubscriptionPlan.js', () => ({ default: { findById: mocks.planFindById } }))
vi.mock('../src/models/Subscription.js', () => ({ default: {
  findOne: mocks.subscriptionFindOne,
  create: mocks.subscriptionCreate,
  updateMany: mocks.subscriptionUpdateMany,
} }))
vi.mock('../src/utils/auditLogger.js', () => ({ logAction: mocks.logAction }))
vi.mock('../src/services/notification.service.js', () => ({
  createManyNotifications: mocks.createManyNotifications,
}))
vi.mock('mongoose', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, default: { ...actual.default, startSession: mocks.startSession } }
})

import { activatePaidTransaction } from '../src/controllers/payment.controller.js'

const transaction = {
  _id: 'tx-1', orderCode: 123, user: 'user-1', plan: 'plan-1', planSlug: 'student-plus',
  planName: 'Student Plus', targetRole: 'student', tier: 'plus', billingCycle: 'monthly', amount: 99000,
}
const query = (value) => ({
  sort: vi.fn().mockReturnThis(),
  session: vi.fn().mockResolvedValue(value),
})

beforeEach(() => {
  vi.resetAllMocks()
  mocks.transactionFindOne.mockResolvedValue(transaction)
  mocks.transactionClaim.mockResolvedValue(transaction)
  mocks.planFindById.mockResolvedValue({ maxSponsoredStudents: 0 })
  mocks.subscriptionFindOne.mockReturnValue(query(null))
  mocks.subscriptionCreate.mockResolvedValue([{ _id: 'sub-1', endDate: new Date('2027-01-01') }])
  mocks.subscriptionUpdateMany.mockResolvedValue({ modifiedCount: 0 })
  mocks.transactionUpdate.mockResolvedValue({ modifiedCount: 1 })
  mocks.logAction.mockResolvedValue(undefined)
  mocks.createManyNotifications.mockResolvedValue([])
  const session = { withTransaction: vi.fn(async (fn) => fn()), endSession: vi.fn() }
  mocks.startSession.mockResolvedValue(session)
})

describe('PayOS transaction activation', () => {
  it('claims pending order, creates one subscription, and records the activation', async () => {
    await expect(activatePaidTransaction(123, { orderCode: 123, amount: 99000, reference: 'ref-1' })).resolves.toMatchObject({
      claimed: { orderCode: 123 },
      subscription: { _id: 'sub-1' },
    })
    expect(mocks.transactionClaim).toHaveBeenCalledWith(
      { orderCode: 123, status: { $in: ['PENDING', 'ACTIVATING'] } },
      expect.objectContaining({ $set: expect.objectContaining({ status: 'ACTIVATING', webhookData: expect.objectContaining({ reference: 'ref-1' }) }) }),
      expect.objectContaining({ new: true, session: expect.any(Object) }),
    )
    expect(mocks.subscriptionFindOne).toHaveBeenNthCalledWith(1, { activationTransaction: 'tx-1' })
    expect(mocks.subscriptionFindOne).toHaveBeenNthCalledWith(2, expect.objectContaining({
      user: 'user-1',
      targetRole: 'student',
      tier: 'plus',
      status: 'active',
    }))
    expect(mocks.subscriptionCreate).toHaveBeenCalledTimes(1)
    expect(mocks.subscriptionUpdateMany).toHaveBeenCalledTimes(1)
    expect(mocks.subscriptionUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        user: 'user-1',
        targetRole: 'student',
        tier: 'plus',
        status: 'active',
        _id: { $ne: 'sub-1' },
      }),
      { status: 'expired' },
      { session: expect.any(Object) },
    )
    expect(mocks.logAction).toHaveBeenCalledTimes(1)
  })

  it('rejects amount mismatch before claiming or activating an order', async () => {
    await expect(activatePaidTransaction(123, { amount: 1 })).rejects.toMatchObject({ code: 'PAYMENT_AMOUNT_MISMATCH' })
    expect(mocks.transactionClaim).not.toHaveBeenCalled()
    expect(mocks.subscriptionCreate).not.toHaveBeenCalled()
  })

  it('does not activate an already-paid order twice', async () => {
    mocks.transactionFindOne.mockResolvedValue({ ...transaction, status: 'PAID' })
    await expect(activatePaidTransaction(123, { amount: 99000 })).resolves.toBeNull()
    expect(mocks.transactionClaim).not.toHaveBeenCalled()
    expect(mocks.subscriptionCreate).not.toHaveBeenCalled()
  })

  it('resumes an activating transaction when its subscription was created before a crash', async () => {
    mocks.transactionFindOne.mockResolvedValue({ ...transaction, status: 'ACTIVATING' })
    const existingSubscription = { _id: 'sub-existing', activationTransaction: 'tx-1' }
    mocks.subscriptionFindOne.mockReturnValueOnce(query(existingSubscription))

    await expect(activatePaidTransaction(123, { amount: 99000, reference: 'ref-1' })).resolves.toMatchObject({
      claimed: { orderCode: 123 },
      subscription: existingSubscription,
    })
    expect(mocks.subscriptionCreate).not.toHaveBeenCalled()
    expect(mocks.subscriptionUpdateMany).toHaveBeenCalledOnce()
    expect(mocks.transactionUpdate).toHaveBeenCalledWith(
      { _id: 'tx-1', status: 'ACTIVATING' },
      { $set: { status: 'PAID' } },
      { session: expect.any(Object) },
    )
  })

  it('does not activate an unknown order', async () => {
    mocks.transactionFindOne.mockResolvedValue(null)
    await expect(activatePaidTransaction(123, { amount: 99000 })).resolves.toBeNull()
    expect(mocks.transactionClaim).not.toHaveBeenCalled()
  })

  it('notifies both the child and the paying parent after activation', async () => {
    const parentTransaction = {
      ...transaction,
      purchasedBy: 'parent-1',
      planName: 'Student Plus',
    }
    mocks.transactionFindOne.mockResolvedValue(parentTransaction)
    mocks.transactionClaim.mockResolvedValue(parentTransaction)

    await activatePaidTransaction(123, { amount: 99000, reference: 'ref-1' })

    expect(mocks.createManyNotifications).toHaveBeenCalledWith([
      expect.objectContaining({
        recipient: 'user-1',
        sender: 'parent-1',
        title: 'Learning plan upgraded',
        link: '/student/dashboard',
      }),
      expect.objectContaining({
        recipient: 'parent-1',
        title: 'Payment successful',
        link: '/parent/plans',
      }),
    ])
  })

  it('keeps other active tiers intact when activating a different tier (PAY-05)', async () => {
    const proTx = { ...transaction, _id: 'tx-pro', orderCode: 999, planSlug: 'student-pro', tier: 'pro' }
    mocks.transactionFindOne.mockResolvedValue(proTx)
    mocks.transactionClaim.mockResolvedValue(proTx)

    await activatePaidTransaction(999, { orderCode: 999, amount: 99000, reference: 'ref-pro' })

    expect(mocks.subscriptionUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ user: 'user-1', targetRole: 'student', tier: 'pro', status: 'active' }),
      { status: 'expired' },
      { session: expect.any(Object) },
    )
  })
})

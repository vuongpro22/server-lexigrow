import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  transactionFind: vi.fn(),
  transactionUpdate: vi.fn(),
  getPaymentInfo: vi.fn(),
  activate: vi.fn(),
}))
vi.mock('../src/models/PaymentTransaction.js', () => ({ default: { find: mocks.transactionFind, updateOne: mocks.transactionUpdate } }))
vi.mock('../src/services/payos.service.js', () => ({ getPayOSPaymentInfo: mocks.getPaymentInfo }))
vi.mock('../src/controllers/payment.controller.js', () => ({ activatePaidTransaction: mocks.activate }))

import { reconcilePendingPayments, schedulePaymentReconciliation } from '../src/services/paymentReconciliation.scheduler.js'

const transaction = { _id: 'tx-1', orderCode: 456, amount: 99000, createdAt: new Date('2026-11-01T00:00:00Z') }
const query = { sort: vi.fn().mockReturnThis(), limit: vi.fn() }

beforeEach(() => {
  vi.resetAllMocks()
  mocks.transactionFind.mockReturnValue(query)
  query.sort.mockReturnThis()
  query.limit.mockResolvedValue([transaction])
  mocks.transactionUpdate.mockResolvedValue({ modifiedCount: 1 })
  mocks.activate.mockResolvedValue({ subscription: { _id: 'sub-1' } })
})

describe('stale PayOS payment reconciliation', () => {
  it('activates a provider-confirmed paid order through the shared idempotent path', async () => {
    mocks.getPaymentInfo.mockResolvedValue({ status: 'PAID', amount: 99000, transactions: [{ reference: 'payos-ref' }] })
    const result = await reconcilePendingPayments({ now: new Date('2026-11-02T00:00:00Z') })
    expect(result).toMatchObject({ checked: 1, paid: 1 })
    expect(mocks.transactionFind).toHaveBeenCalledWith(expect.objectContaining({
      status: { $in: ['PENDING', 'ACTIVATING'] },
      createdAt: { $lte: new Date('2026-11-01T23:30:00Z') },
      $and: expect.any(Array),
    }))
    expect(mocks.activate).toHaveBeenCalledWith(456, expect.objectContaining({ amount: 99000, reference: 'payos-ref' }))
  })

  it('finds interrupted activations so the worker can resume them after a process restart', async () => {
    mocks.transactionFind.mockReturnValue(query)
    query.limit.mockResolvedValueOnce([{ ...transaction, status: 'ACTIVATING' }])
    mocks.getPaymentInfo.mockResolvedValue({ status: 'PAID', amount: 99000 })

    const result = await reconcilePendingPayments()

    expect(result).toMatchObject({ checked: 1, paid: 1 })
    expect(mocks.transactionFind).toHaveBeenCalledWith(expect.objectContaining({
      status: { $in: ['PENDING', 'ACTIVATING'] },
      createdAt: { $lte: expect.any(Date) },
      $and: expect.any(Array),
    }))
    expect(mocks.activate).toHaveBeenCalledOnce()
  })

  it('records exponential backoff on failures and leaves pending orders open', async () => {
    mocks.getPaymentInfo.mockResolvedValue({ status: 'PAID', amount: 1 })
    const mismatch = await reconcilePendingPayments()
    expect(mismatch.failed).toBe(1)
    expect(mocks.activate).not.toHaveBeenCalled()
    expect(mocks.transactionUpdate).toHaveBeenCalledWith(
      { _id: 'tx-1' },
      { $set: expect.objectContaining({ reconcileAttempts: 1, nextReconcileAt: expect.any(Date) }) },
    )

    vi.clearAllMocks()
    mocks.transactionFind.mockReturnValue(query)
    query.limit.mockResolvedValue([transaction])
    mocks.getPaymentInfo.mockResolvedValue({ status: 'PENDING' })
    const pending = await reconcilePendingPayments()
    expect(pending.pending).toBe(1)
    expect(mocks.transactionUpdate).not.toHaveBeenCalled()

    vi.clearAllMocks()
    mocks.transactionFind.mockReturnValue(query)
    query.limit.mockResolvedValue([transaction])
    mocks.getPaymentInfo.mockRejectedValue(new Error('offline'))
    const failure = await reconcilePendingPayments()
    expect(failure.failed).toBe(1)
    expect(mocks.transactionUpdate).toHaveBeenCalledWith(
      { _id: 'tx-1' },
      { $set: expect.objectContaining({ reconcileAttempts: 1, nextReconcileAt: expect.any(Date), reconcilingUntil: null }) },
    )
  })

  it('dry-run reports expected actions without activating or changing transactions', async () => {
    mocks.getPaymentInfo.mockResolvedValueOnce({ status: 'PAID', amount: 99000 })
    const paid = await reconcilePendingPayments({ dryRun: true })
    expect(paid).toMatchObject({ checked: 1, wouldActivate: 1, paid: 0 })

    mocks.getPaymentInfo.mockResolvedValueOnce({ status: 'CANCELLED' })
    const cancelled = await reconcilePendingPayments({ dryRun: true })
    expect(cancelled).toMatchObject({ checked: 1, wouldClose: 1, cancelled: 0 })

    expect(mocks.activate).not.toHaveBeenCalled()
    expect(mocks.transactionUpdate).not.toHaveBeenCalled()
  })

  it('enables dry-run mode for the scheduler when configured', async () => {
    const { default: cron } = await import('node-cron')
    const schedule = vi.spyOn(cron, 'schedule').mockImplementation((_expression, callback) => ({ callback }))
    process.env.PAYMENT_RECONCILIATION_DRY_RUN = 'true'
    try {
      const task = schedulePaymentReconciliation()
      mocks.getPaymentInfo.mockResolvedValue({ status: 'PAID', amount: 99000 })
      await task.callback()
      expect(mocks.activate).not.toHaveBeenCalled()
      expect(mocks.transactionUpdate).not.toHaveBeenCalled()
    } finally {
      delete process.env.PAYMENT_RECONCILIATION_DRY_RUN
      schedule.mockRestore()
    }
  })

  it('does not close an interrupted activation when provider later reports a terminal state', async () => {
    query.limit.mockResolvedValueOnce([{ ...transaction, status: 'ACTIVATING' }])
    mocks.getPaymentInfo.mockResolvedValue({ status: 'CANCELLED' })

    const result = await reconcilePendingPayments()

    expect(result.pending).toBe(1)
    expect(mocks.transactionUpdate).not.toHaveBeenCalled()
  })

  it('marks only provider-confirmed terminal unpaid states with a conditional update', async () => {
    mocks.getPaymentInfo.mockResolvedValue({ status: 'CANCELLED' })
    const result = await reconcilePendingPayments()
    expect(result.cancelled).toBe(1)
    expect(mocks.transactionUpdate).toHaveBeenCalledWith(
      { _id: 'tx-1', status: 'PENDING' },
      { $set: { status: 'CANCELLED', reconcilingUntil: null } },
    )
  })

  it('skips transactions already leased by another replica (PAY-08)', async () => {
    const PaymentTransaction = (await import('../src/models/PaymentTransaction.js')).default
    PaymentTransaction.findOneAndUpdate = vi.fn().mockResolvedValueOnce(null)
    try {
      const result = await reconcilePendingPayments()
      expect(result.skipped).toBe(1)
      expect(result.checked).toBe(0)
      expect(mocks.getPaymentInfo).not.toHaveBeenCalled()
    } finally {
      delete PaymentTransaction.findOneAndUpdate
    }
  })

  it('skips scheduling cron when PAYMENT_RECONCILIATION_ENABLED is false', async () => {
    const { default: cron } = await import('node-cron')
    const schedule = vi.spyOn(cron, 'schedule')
    process.env.PAYMENT_RECONCILIATION_ENABLED = 'false'
    try {
      expect(schedulePaymentReconciliation()).toBeNull()
      expect(schedule).not.toHaveBeenCalled()
    } finally {
      delete process.env.PAYMENT_RECONCILIATION_ENABLED
      schedule.mockRestore()
    }
  })
})

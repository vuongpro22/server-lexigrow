import cron from 'node-cron'
import PaymentTransaction from '../models/PaymentTransaction.js'
import { getPayOSPaymentInfo } from './payos.service.js'
import { activatePaidTransaction } from '../controllers/payment.controller.js'

const DEFAULT_MAX_ATTEMPTS = 8
const DEFAULT_BASE_BACKOFF_MS = 60 * 1000
const DEFAULT_MAX_BACKOFF_MS = 6 * 60 * 60 * 1000
const DEFAULT_LEASE_MS = 120 * 1000

async function recordReconcileFailure(transactionId, priorAttempts, now, baseBackoffMs, maxBackoffMs) {
  const nextAttempts = (priorAttempts || 0) + 1
  const delayMs = Math.min(maxBackoffMs, baseBackoffMs * (2 ** Math.min(nextAttempts - 1, 10)))
  await PaymentTransaction.updateOne(
    { _id: transactionId },
    {
      $set: {
        reconcileAttempts: nextAttempts,
        nextReconcileAt: new Date(now.getTime() + delayMs),
        reconcilingUntil: null,
      },
    },
  )
}

async function releaseLeaseIfClaimed(transactionId, claimedWithLock) {
  if (!claimedWithLock) return
  await PaymentTransaction.updateOne(
    { _id: transactionId },
    { $set: { reconcilingUntil: null } },
  )
}

export async function reconcilePendingPayments({
  now = new Date(),
  minAgeMs = 30 * 60 * 1000,
  limit = 50,
  dryRun = false,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  baseBackoffMs = DEFAULT_BASE_BACKOFF_MS,
  maxBackoffMs = DEFAULT_MAX_BACKOFF_MS,
  leaseMs = DEFAULT_LEASE_MS,
} = {}) {
  const cutoff = new Date(now.getTime() - minAgeMs)
  const transactions = await PaymentTransaction.find({
    status: { $in: ['PENDING', 'ACTIVATING'] },
    createdAt: { $lte: cutoff },
    $and: [
      { $or: [{ nextReconcileAt: null }, { nextReconcileAt: { $exists: false } }, { nextReconcileAt: { $lte: now } }] },
      { $or: [{ reconcilingUntil: null }, { reconcilingUntil: { $exists: false } }, { reconcilingUntil: { $lte: now } }] },
      { $or: [{ reconcileAttempts: { $lt: maxAttempts } }, { reconcileAttempts: { $exists: false } }] },
    ],
  })
    .sort({ createdAt: 1, _id: 1 })
    .limit(limit)

  const result = { checked: 0, paid: 0, cancelled: 0, expired: 0, pending: 0, failed: 0, skipped: 0, wouldActivate: 0, wouldClose: 0 }
  const canLease = typeof PaymentTransaction.findOneAndUpdate === 'function'

  for (const transaction of transactions) {
    let activeTx = transaction
    let claimedWithLock = false
    if (canLease && !dryRun) {
      activeTx = await PaymentTransaction.findOneAndUpdate(
        {
          _id: transaction._id,
          status: transaction.status,
          $or: [{ reconcilingUntil: null }, { reconcilingUntil: { $exists: false } }, { reconcilingUntil: { $lte: now } }],
        },
        { $set: { reconcilingUntil: new Date(now.getTime() + leaseMs) } },
        { new: true },
      )
      if (!activeTx) {
        result.skipped++
        continue
      }
      claimedWithLock = true
    }

    result.checked++
    try {
      if (activeTx.status === 'ACTIVATING') {
        if (dryRun) {
          result.wouldActivate++
          continue
        }
        const providerStatus = await getPayOSPaymentInfo(activeTx.orderCode)
        if (providerStatus.status !== 'PAID' || providerStatus.amount !== activeTx.amount) {
          result.pending++
          await releaseLeaseIfClaimed(activeTx._id, claimedWithLock)
          continue
        }
        const activation = await activatePaidTransaction(activeTx.orderCode, {
          ...(activeTx.webhookData || {}),
          orderCode: activeTx.orderCode,
          amount: activeTx.amount,
        })
        await releaseLeaseIfClaimed(activeTx._id, claimedWithLock)
        if (activation) result.paid++
        else result.pending++
        continue
      }

      const payment = await getPayOSPaymentInfo(activeTx.orderCode)
      if (payment.status === 'PAID') {
        if (payment.amount !== activeTx.amount) {
          console.warn('[PaymentReconciliation] Provider amount mismatch', { orderCode: activeTx.orderCode })
          await recordReconcileFailure(activeTx._id, activeTx.reconcileAttempts, now, baseBackoffMs, maxBackoffMs)
          result.failed++
          continue
        }
        if (dryRun) {
          result.wouldActivate++
          continue
        }
        const activation = await activatePaidTransaction(activeTx.orderCode, {
          orderCode: activeTx.orderCode,
          amount: payment.amount,
          code: '00',
          desc: 'Reconciled from PayOS payment status',
          reference: payment.transactions?.at(-1)?.reference || '',
        })
        await releaseLeaseIfClaimed(activeTx._id, claimedWithLock)
        if (activation) result.paid++
        else result.pending++
      } else if (payment.status === 'CANCELLED' || payment.status === 'EXPIRED' || payment.status === 'FAILED') {
        const status = payment.status === 'CANCELLED' ? 'CANCELLED' : 'EXPIRED'
        if (dryRun) {
          result.wouldClose++
          continue
        }
        const updated = await PaymentTransaction.updateOne(
          { _id: activeTx._id, status: 'PENDING' },
          { $set: { status, reconcilingUntil: null } },
        )
        if (updated.modifiedCount) result[status.toLowerCase()]++
      } else {
        await releaseLeaseIfClaimed(activeTx._id, claimedWithLock)
        result.pending++
      }
    } catch (error) {
      result.failed++
      await recordReconcileFailure(activeTx._id, activeTx.reconcileAttempts, now, baseBackoffMs, maxBackoffMs).catch(() => {})
      console.warn('[PaymentReconciliation] PayOS status lookup failed', {
        orderCode: activeTx.orderCode,
        code: error?.code || 'PAYOS_LOOKUP_FAILED',
      })
    }
  }
  return result
}

export function schedulePaymentReconciliation() {
  if (process.env.PAYMENT_RECONCILIATION_ENABLED === 'false') {
    return null
  }
  return cron.schedule('*/10 * * * *', async () => {
    try {
      const dryRun = process.env.PAYMENT_RECONCILIATION_DRY_RUN === 'true'
      console.info('[PaymentReconciliation] Check completed:', await reconcilePendingPayments({ dryRun }))
    } catch (error) {
      console.error('[PaymentReconciliation] Check failed:', error?.message || 'unknown error')
    }
  }, { noOverlap: true, name: 'pending-payment-reconciliation' })
}

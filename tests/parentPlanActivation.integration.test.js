import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import mongoose from 'mongoose'
import { MongoMemoryServer } from 'mongodb-memory-server'
import User from '../src/models/User.js'
import ParentStudentLink from '../src/models/ParentStudentLink.js'
import SubscriptionPlan from '../src/models/SubscriptionPlan.js'
import Subscription from '../src/models/Subscription.js'
import PaymentTransaction from '../src/models/PaymentTransaction.js'
import Notification from '../src/models/Notification.js'
import { createPayOSPaymentLink } from '../src/services/payos.service.js'
import {
  createPayment,
  activatePaidTransaction,
  getMySubscription,
  getMyPaymentStatus,
} from '../src/controllers/payment.controller.js'

vi.mock('../src/services/payos.service.js', () => ({
  createPayOSPaymentLink: vi.fn(),
  verifyPayOSWebhookData: vi.fn(),
}))

let mongo
let parent
let child
let studentPlan

function response() {
  const res = {
    statusCode: null,
    body: null,
    status: vi.fn(code => {
      res.statusCode = code
      return res
    }),
    json: vi.fn(body => {
      res.body = body
      return res
    }),
  }
  return res
}

async function invoke(handler, req) {
  const res = response()
  const next = vi.fn()
  await handler(req, res, next)
  return { res, next }
}

beforeAll(async () => {
  mongo = await MongoMemoryServer.create()
  await mongoose.connect(mongo.getUri())
  await Promise.all(Object.values(mongoose.models).map(model => model.init()))
}, 120000)

afterAll(async () => {
  await mongoose.disconnect()
  if (mongo) await mongo.stop()
}, 30000)

beforeEach(async () => {
  await Promise.all(Object.values(mongoose.models).map(model => model.deleteMany({})))
  ;[parent, child] = await User.create([
    { name: 'Parent', email: 'parent@example.test', password: 'password1', role: 'parent', accountStatus: 'active' },
    { name: 'Child', email: 'child@example.test', password: 'password1', role: 'student', accountStatus: 'active' },
  ])
  await ParentStudentLink.create({
    parent: parent._id,
    student: child._id,
    relationship: 'mother',
    status: 'active',
  })
  studentPlan = await SubscriptionPlan.create({
    slug: 'student-plus',
    name: 'Student Plus',
    targetRole: 'student',
    tier: 'plus',
    monthlyPrice: 59000,
    yearlyPrice: 499000,
    features: ['15 AI essays/day'],
    isActive: true,
  })
  createPayOSPaymentLink.mockResolvedValue({
    paymentLinkId: 'payos-1',
    checkoutUrl: 'https://checkout.payos.vn/test',
    qrCode: 'qr',
  })
})

describe('Parent plan purchase end-to-end', () => {
  it('activates the subscription on the child account and notifies both sides', async () => {
    const purchase = await invoke(createPayment, {
      user: parent,
      body: {
        planSlug: studentPlan.slug,
        billingCycle: 'monthly',
        studentId: String(child._id),
      },
    })

    expect(purchase.next).not.toHaveBeenCalled()
    expect(purchase.res.statusCode).toBe(200)
    const orderCode = purchase.res.body.data.orderCode
    expect(createPayOSPaymentLink).toHaveBeenCalledWith(expect.objectContaining({
      amount: 59000,
      buyerEmail: parent.email,
    }))

    const pending = await PaymentTransaction.findOne({ orderCode })
    expect(String(pending.user)).toBe(String(child._id))
    expect(String(pending.purchasedBy)).toBe(String(parent._id))
    expect(pending.status).toBe('PENDING')

    await activatePaidTransaction(orderCode, {
      orderCode,
      amount: 59000,
      reference: 'payos-ref',
    })

    const paid = await PaymentTransaction.findOne({ orderCode })
    expect(paid.status).toBe('PAID')

    const subscription = await Subscription.findOne({
      user: child._id,
      targetRole: 'student',
      status: 'active',
    })
    expect(subscription).toMatchObject({
      tier: 'plus',
      planSlug: 'student-plus',
      amountPaid: 59000,
    })

    const childTier = await invoke(getMySubscription, { user: child })
    expect(childTier.res.body.data).toMatchObject({
      tier: 'plus',
      source: 'personal_subscription',
    })

    const parentStatus = await invoke(getMyPaymentStatus, {
      user: parent,
      params: { orderCode: String(orderCode) },
    })
    expect(parentStatus.res.body.data.status).toBe('PAID')
    expect(parentStatus.res.body.data.beneficiary).toMatchObject({ name: 'Child' })

    expect(await Notification.countDocuments({ recipient: child._id })).toBe(1)
    expect(await Notification.countDocuments({ recipient: parent._id })).toBe(1)
  })

  it('does not activate when PayOS amount does not match the transaction', async () => {
    const purchase = await invoke(createPayment, {
      user: parent,
      body: {
        planSlug: studentPlan.slug,
        billingCycle: 'monthly',
        studentId: String(child._id),
      },
    })
    const orderCode = purchase.res.body.data.orderCode

    await expect(activatePaidTransaction(orderCode, {
      orderCode,
      amount: 1000,
    })).rejects.toMatchObject({ code: 'PAYMENT_AMOUNT_MISMATCH' })

    const transaction = await PaymentTransaction.findOne({ orderCode })
    expect(transaction.status).toBe('PENDING')
    expect(await Subscription.countDocuments({ user: child._id, status: 'active' })).toBe(0)
  })
})

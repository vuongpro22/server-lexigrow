import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import User from '../src/models/User.js'
import ParentStudentLink from '../src/models/ParentStudentLink.js'
import SubscriptionPlan from '../src/models/SubscriptionPlan.js'
import Subscription from '../src/models/Subscription.js'
import PaymentTransaction from '../src/models/PaymentTransaction.js'
import { createPayOSPaymentLink } from '../src/services/payos.service.js'
import { getUserEffectiveTier } from '../src/services/tier.service.js'
import { createPayment, getChildSubscription, getMyPaymentStatus, resolveClientUrl } from '../src/controllers/payment.controller.js'

vi.mock('../src/models/User.js', () => ({ default: { findById: vi.fn(), findOne: vi.fn() } }))
vi.mock('../src/models/ParentStudentLink.js', () => ({ default: { findOne: vi.fn() } }))
vi.mock('../src/models/SubscriptionPlan.js', () => ({ default: { findOne: vi.fn() } }))
vi.mock('../src/models/Subscription.js', () => ({ default: { find: vi.fn(), findOne: vi.fn() } }))
vi.mock('../src/models/PaymentTransaction.js', () => ({
  default: {
    create: vi.fn(),
    findByIdAndUpdate: vi.fn(),
    find: vi.fn(),
    findOne: vi.fn(),
  },
}))
vi.mock('../src/models/Class.js', () => ({ default: { find: vi.fn() } }))
vi.mock('../src/services/payos.service.js', () => ({
  createPayOSPaymentLink: vi.fn(),
  verifyPayOSWebhookData: vi.fn(),
}))
vi.mock('../src/services/tier.service.js', () => ({ getUserEffectiveTier: vi.fn() }))
vi.mock('../src/utils/auditLogger.js', () => ({ logAction: vi.fn().mockResolvedValue(undefined) }))

const parent = { _id: 'parent1', name: 'Parent', email: 'parent@example.com', role: 'parent' }
const child = {
  _id: '507f1f77bcf86cd799439011',
  name: 'Child',
  email: 'child@example.com',
  role: 'student',
  accountStatus: 'active',
  englishLevel: 'B1',
}
const plan = {
  _id: 'plan1',
  slug: 'student-plus',
  name: 'Student Plus',
  tier: 'plus',
  targetRole: 'student',
  monthlyPrice: 59000,
  yearlyPrice: 499000,
  isActive: true,
}

const request = (body = {}) => ({ user: parent, params: {}, body })
const response = () => ({ status: vi.fn().mockReturnThis(), json: vi.fn() })

function chain(value) {
  return {
    select: vi.fn().mockReturnThis(),
    populate: vi.fn().mockReturnThis(),
    sort: vi.fn().mockReturnThis(),
    lean: vi.fn().mockResolvedValue(value),
    then: (resolve, reject) => Promise.resolve(value).then(resolve, reject),
  }
}

describe('Parent purchases a plan for a linked child', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ParentStudentLink.findOne.mockResolvedValue({ _id: 'link1', status: 'active' })
    User.findById.mockReturnValue({ select: vi.fn().mockResolvedValue(child) })
    SubscriptionPlan.findOne.mockResolvedValue(plan)
    PaymentTransaction.create.mockImplementation(async data => ({ _id: 'tx1', ...data }))
    PaymentTransaction.findByIdAndUpdate.mockResolvedValue({})
    createPayOSPaymentLink.mockResolvedValue({
      paymentLinkId: 'payos1',
      checkoutUrl: 'https://checkout.payos.vn/test',
      qrCode: 'qr',
    })
    getUserEffectiveTier.mockResolvedValue({ tier: 'free', source: 'free' })
  })

  it('creates a payment where the child receives the plan and the parent pays', async () => {
    const res = response()
    const next = vi.fn()

    await createPayment(request({
      planSlug: 'student-plus',
      billingCycle: 'monthly',
      studentId: child._id,
    }), res, next)

    expect(next).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(200)
    expect(ParentStudentLink.findOne).toHaveBeenCalledWith({
      parent: parent._id,
      student: child._id,
      status: 'active',
    })
    expect(PaymentTransaction.create).toHaveBeenCalledWith(expect.objectContaining({
      user: child._id,
      purchasedBy: parent._id,
      targetRole: 'student',
      amount: 59000,
    }))
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        beneficiary: { _id: child._id, name: child.name },
      }),
    }))
  })

  it('rejects a malformed student id', async () => {
    const next = vi.fn()

    await createPayment(request({ planSlug: 'student-plus', studentId: 'not-an-object-id' }), response(), next)

    expect(next).toHaveBeenCalledOnce()
    expect(next.mock.calls[0][0].statusCode).toBe(400)
    expect(PaymentTransaction.create).not.toHaveBeenCalled()
  })

  it('rejects a child without an active parent link', async () => {
    ParentStudentLink.findOne.mockResolvedValue(null)
    const next = vi.fn()

    await createPayment(request({ planSlug: 'student-plus', studentId: child._id }), response(), next)

    expect(next).toHaveBeenCalledOnce()
    expect(next.mock.calls[0][0].statusCode).toBe(403)
    expect(PaymentTransaction.create).not.toHaveBeenCalled()
  })

  it('rejects a Teacher plan bought by a parent', async () => {
    SubscriptionPlan.findOne.mockResolvedValue({
      ...plan,
      targetRole: 'teacher',
      slug: 'teacher-plus',
      name: 'Teacher Plus',
    })
    const next = vi.fn()

    await createPayment(request({ planSlug: 'teacher-plus', studentId: child._id }), response(), next)

    expect(next).toHaveBeenCalledOnce()
    expect(next.mock.calls[0][0].statusCode).toBe(400)
    expect(PaymentTransaction.create).not.toHaveBeenCalled()
  })

  it('rejects a plan lower than the child current tier', async () => {
    getUserEffectiveTier.mockResolvedValue({ tier: 'pro', source: 'personal_subscription' })
    const next = vi.fn()

    await createPayment(request({ planSlug: 'student-plus', studentId: child._id }), response(), next)

    expect(next).toHaveBeenCalledOnce()
    expect(next.mock.calls[0][0].statusCode).toBe(400)
    expect(next.mock.calls[0][0].code).toBe('PLAN_NOT_AN_UPGRADE')
    expect(PaymentTransaction.create).not.toHaveBeenCalled()
  })

  it('rejects the same tier when the child is teacher-sponsored', async () => {
    getUserEffectiveTier.mockResolvedValue({ tier: 'plus', source: 'teacher_sponsored' })
    const next = vi.fn()

    await createPayment(request({ planSlug: 'student-plus', studentId: child._id }), response(), next)

    expect(next).toHaveBeenCalledOnce()
    expect(next.mock.calls[0][0].statusCode).toBe(400)
    expect(next.mock.calls[0][0].code).toBe('PLAN_ALREADY_SPONSORED')
    expect(PaymentTransaction.create).not.toHaveBeenCalled()
  })

  it('returns the child current effective tier and active personal plans', async () => {
    User.findOne.mockReturnValue({ select: vi.fn().mockResolvedValue(child) })
    getUserEffectiveTier.mockResolvedValue({
      tier: 'plus',
      source: 'personal_subscription',
      planName: 'Student Plus',
    })
    Subscription.find.mockReturnValue(chain([{
      tier: 'plus',
      planSlug: 'student-plus',
      endDate: '2027-01-01T00:00:00.000Z',
    }]))
    const res = response()

    await getChildSubscription({ user: parent, params: { studentId: child._id } }, res, vi.fn())

    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        child: expect.objectContaining({ _id: child._id }),
        tierInfo: expect.objectContaining({ tier: 'plus' }),
        activeSubscriptions: [expect.objectContaining({ planSlug: 'student-plus' })],
      }),
    }))
  })

  it('lets the parent read a child payment status', async () => {
    PaymentTransaction.findOne.mockReturnValue(chain({
      orderCode: 123,
      status: 'PAID',
      user: { _id: child._id, name: child.name },
      purchasedBy: parent._id,
    }))
    const res = response()

    await getMyPaymentStatus({ user: parent, params: { orderCode: '123' } }, res, vi.fn())

    expect(PaymentTransaction.findOne).toHaveBeenCalledWith({
      orderCode: 123,
      $or: [
        { user: parent._id },
        { purchasedBy: parent._id },
      ],
    })
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        beneficiary: expect.objectContaining({ _id: child._id }),
      }),
    }))
  })
})

describe('resolveClientUrl for PayOS redirects', () => {
  const originalClientUrl = process.env.CLIENT_URL

  afterEach(() => {
    if (originalClientUrl === undefined) delete process.env.CLIENT_URL
    else process.env.CLIENT_URL = originalClientUrl
  })

  it('uses configured non-localhost CLIENT_URL without trailing slash', () => {
    process.env.CLIENT_URL = 'https://lexigrow.id.vn/'
    expect(resolveClientUrl({ headers: { host: 'api.lexigrow.id.vn' } })).toBe('https://lexigrow.id.vn')
  })

  it('uses the request domain when CLIENT_URL is missing or left as localhost on production', () => {
    process.env.CLIENT_URL = 'http://localhost:5173'
    const prodReq = {
      headers: {
        origin: 'https://lexigrow.id.vn',
        host: 'lexigrow.id.vn',
      },
    }
    expect(resolveClientUrl(prodReq)).toBe('https://lexigrow.id.vn')

    delete process.env.CLIENT_URL
    const proxiedReq = {
      protocol: 'http',
      headers: {
        host: 'lexigrow.id.vn',
        'x-forwarded-proto': 'https',
      },
    }
    expect(resolveClientUrl(proxiedReq)).toBe('https://lexigrow.id.vn')
  })

  it('ignores a spoofed Origin header whose host does not match the request host', () => {
    delete process.env.CLIENT_URL
    const req = {
      protocol: 'http',
      headers: {
        origin: 'https://evil.example',
        host: 'lexigrow.id.vn',
        'x-forwarded-proto': 'https',
      },
    }
    expect(resolveClientUrl(req)).toBe('https://lexigrow.id.vn')
  })

  it('keeps localhost CLIENT_URL during local development', () => {
    process.env.CLIENT_URL = 'http://localhost:5173'
    const localReq = {
      protocol: 'http',
      headers: {
        origin: 'http://localhost:5173',
        host: 'localhost:5000',
      },
    }
    expect(resolveClientUrl(localReq)).toBe('http://localhost:5173')
  })
})

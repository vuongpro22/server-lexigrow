import { beforeEach, describe, expect, it, vi } from 'vitest'
import Subscription from '../src/models/Subscription.js'
import SubscriptionPlan from '../src/models/SubscriptionPlan.js'
import Class from '../src/models/Class.js'
import { getTeacherSponsorshipStatus } from '../src/controllers/payment.controller.js'

vi.mock('../src/models/Subscription.js', () => ({ default: { findOne: vi.fn() } }))
vi.mock('../src/models/SubscriptionPlan.js', () => ({ default: { findOne: vi.fn() } }))
vi.mock('../src/models/Class.js', () => ({ default: { find: vi.fn() } }))
vi.mock('../src/models/PaymentTransaction.js', () => ({ default: {} }))
vi.mock('../src/services/payos.service.js', () => ({
  createPayOSPaymentLink: vi.fn(),
  verifyPayOSWebhookData: vi.fn(),
}))
vi.mock('../src/services/tier.service.js', () => ({ getUserEffectiveTier: vi.fn() }))
vi.mock('../src/utils/auditLogger.js', () => ({ logAction: vi.fn() }))

const request = () => ({ user: { _id: 'teacher1', role: 'teacher' } })
const response = () => ({ status: vi.fn().mockReturnThis(), json: vi.fn() })

function classQuery(classes) {
  const query = {
    sort: vi.fn().mockImplementation(() => query),
    populate: vi.fn().mockResolvedValue(classes),
  }
  return query
}

describe('teacher sponsorship status', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('uses the quota purchased in the subscription instead of a later plan change', async () => {
    Subscription.findOne.mockReturnValue({
      sort: vi.fn().mockResolvedValue({
        _id: 'sub1',
        planSlug: 'teacher-plus',
        tier: 'plus',
        maxSponsoredStudents: 30,
        endDate: new Date('2027-01-01T00:00:00Z'),
      }),
    })
    SubscriptionPlan.findOne.mockResolvedValue({ maxSponsoredStudents: 100 })
    Class.find.mockReturnValue(classQuery([
      {
        name: 'Class A',
        students: [
          { _id: 'student1', name: 'One', email: 'one@example.com', englishLevel: 'A2' },
          { _id: 'student2', name: 'Two', email: 'two@example.com', englishLevel: 'B1' },
        ],
      },
    ]))

    const res = response()
    await getTeacherSponsorshipStatus(request(), res, vi.fn())

    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      data: expect.objectContaining({
        maxSponsoredQuota: 30,
        usedQuota: 2,
        remainingQuota: 28,
        sponsoredStudents: [
          expect.objectContaining({ _id: 'student1' }),
          expect.objectContaining({ _id: 'student2' }),
        ],
      }),
    })
  })
})

import Class from '../models/Class.js'
import Subscription from '../models/Subscription.js'
import SubscriptionPlan from '../models/SubscriptionPlan.js'
import ErrorResponse from '../utils/ErrorResponse.js'
import { findBestActiveSubscription } from '../utils/subscriptionTier.js'

// Archived classes do not consume class slots, but drafts do: otherwise a
// teacher could park classes as drafts and keep creating new ones forever.
export async function assertClassCapacity(teacherId, { excludeClassId = null } = {}) {
  const now = new Date()
  const subscription = await findBestActiveSubscription(Subscription, {
    user: teacherId,
    targetRole: 'teacher',
    status: 'active',
    startDate: { $lte: now },
    endDate: { $gte: now },
  })
  const plan = subscription
    ? await SubscriptionPlan.findOne({ _id: subscription.plan, targetRole: 'teacher' })
    : null
  const limit = Number.isInteger(plan?.maxClasses) && plan.maxClasses >= 0
    ? plan.maxClasses
    : 1
  const filter = { teacher: teacherId, status: { $ne: 'archived' } }
  if (excludeClassId) filter._id = { $ne: excludeClassId }
  const used = await Class.countDocuments(filter)
  if (used >= limit) {
    throw new ErrorResponse(
      `Bạn đã đạt giới hạn ${limit} lớp chưa lưu trữ của gói hiện tại. Vui lòng lưu trữ lớp hoặc nâng cấp gói để tiếp tục.`,
      403,
    )
  }
}

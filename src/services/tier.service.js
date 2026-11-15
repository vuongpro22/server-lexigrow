import User from '../models/User.js'
import Class from '../models/Class.js'
import Subscription from '../models/Subscription.js'
import SubscriptionPlan from '../models/SubscriptionPlan.js'
import { getTeacherStudentQuota } from './studentQuota.service.js'
import { findBestActiveSubscription, isBetterEffectiveTier } from '../utils/subscriptionTier.js'
import { dayBoundary } from '../utils/learning.js'

const planLimit = (plan, fallback) => Number.isFinite(plan?.dailyAiEssayLimit)
  ? plan.dailyAiEssayLimit
  : fallback
const isBetterTier = isBetterEffectiveTier
const classOrder = (a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0)
  || String(a._id).localeCompare(String(b._id))
const timezoneDayStart = (now, timezone = 'Asia/Ho_Chi_Minh') => dayBoundary(now, 0, timezone)
export { timezoneDayStart }

const getPlanForSubscription = async (subscription, targetRole) => {
  const planId = subscription.plan?._id || subscription.plan
  if (planId) {
    const plan = await SubscriptionPlan.findOne({ _id: planId, targetRole })
    if (plan) return plan
  }

  return subscription.planSlug
    ? SubscriptionPlan.findOne({ slug: subscription.planSlug, targetRole })
    : null
}

const toPersonalTier = (subscription, plan) => {
  const dailyLimit = planLimit(plan, subscription.tier === 'plus' ? 15 : 9999)
  return {
    tier: subscription.tier,
    source: 'personal_subscription',
    subscription,
    planName: plan?.name || `${subscription.tier.toUpperCase()} Plan`,
    dailyAiEssayLimit: dailyLimit,
    maxClasses: plan?.maxClasses ?? 1,
    isUnlimitedAi: dailyLimit === -1 || dailyLimit >= 9999,
    features: plan?.features || [],
    expiresAt: subscription.endDate,
  }
}

const toSponsoredTier = (cls, subscription, plan, limit) => {
  const dailyLimit = planLimit(plan, subscription.tier === 'plus' ? 15 : 9999)
  return {
    tier: subscription.tier,
    source: 'teacher_sponsored',
    sponsoredByTeacher: {
      _id: cls.teacher._id,
      name: cls.teacher.name,
      email: cls.teacher.email,
      className: cls.name,
    },
    // planName kept for backward-compat; frontend should use sponsoredByTeacher.name + t()
    planName: `${cls.teacher.name} (${subscription.tier.toUpperCase()})`,
    dailyAiEssayLimit: dailyLimit,
    isUnlimitedAi: dailyLimit === -1 || dailyLimit >= 9999,
    features: [],
    expiresAt: subscription.endDate,
    maxSponsoredStudents: limit,
    maxClasses: plan?.maxClasses ?? 1,
  }
}

const isWithinTeacherCapacity = (studentId, classes, limit) => {
  const designated = []
  const seen = new Set()
  const max = Math.max(0, limit)

  // Classes and their students arrive in enrolment order from the caller.
  // Keep that order so the students shown in the teacher sponsorship panel are
  // exactly the students who receive sponsorship; never re-sort by ObjectId,
  // which would let a newly enrolled student displace an existing one.
  for (const cls of classes) {
    for (const student of cls.students || []) {
      const id = String(student)
      if (seen.has(id)) continue
      seen.add(id)
      if (designated.length < max) designated.push(id)
    }
  }

  return designated.includes(String(studentId))
}

export async function getUserEffectiveTier(userOrId) {
  const userId = typeof userOrId === 'object' ? userOrId._id || userOrId.id : userOrId
  const user = typeof userOrId === 'object' && userOrId.role ? userOrId : await User.findById(userId)
  if (!user) {
    return {
      tier: 'free',
      source: 'default',
      dailyAiEssayLimit: 3,
      isUnlimitedAi: false,
      features: ['3 bài chấm AI/ngày', 'Tham gia 1 lớp học', '3 bộ từ vựng cơ bản'],
    }
  }

  const now = new Date()
  const directSub = await findBestActiveSubscription(Subscription, {
    user: user._id,
    targetRole: user.role,
    status: 'active',
    startDate: { $lte: now },
    endDate: { $gte: now },
  })
  let effectiveTier = directSub
    ? toPersonalTier(directSub, await getPlanForSubscription(directSub, user.role))
    : null

  if (user.role === 'student') {
    const enrolledClasses = (await Class.find({
      students: user._id,
      status: 'active',
    }).populate('teacher', 'name email accountStatus')).sort(classOrder)
    for (const cls of enrolledClasses) {
      if (!cls.teacher || (cls.teacher.accountStatus && cls.teacher.accountStatus !== 'active')) continue
      const { subscription: teacherSub, limit } = await getTeacherStudentQuota(cls.teacher._id)
      if (!teacherSub) continue
      const allTeacherClasses = await Class.find({
        teacher: cls.teacher._id,
        status: 'active',
      }).sort({ createdAt: 1, _id: 1 })
      if (!isWithinTeacherCapacity(user._id, allTeacherClasses, limit)) continue
      const teacherPlan = await getPlanForSubscription(teacherSub, 'teacher')
      const candidate = toSponsoredTier(cls, teacherSub, teacherPlan, limit)
      if (isBetterTier(candidate, effectiveTier)) effectiveTier = candidate
    }
  }

  if (effectiveTier) return effectiveTier
  const freePlan = await SubscriptionPlan.findOne({ targetRole: user.role, tier: 'free', isActive: true })
  const freeLimit = planLimit(freePlan, 3)
  return {
    tier: 'free',
    source: 'free',
    planName: 'Free',
    dailyAiEssayLimit: freeLimit,
    maxClasses: 1,
    isUnlimitedAi: freeLimit === -1 || freeLimit >= 9999,
    features: [],
  }
}

export async function checkDailyEssayQuota(userOrId) {
  const { checkDailyEssayQuota: checkQuota } = await import('./aiQuota.service.js')
  return checkQuota(userOrId)
}

export async function consumeDailyEssayQuota(userOrId, options) {
  const { consumeDailyEssayQuota: consumeQuota } = await import('./aiQuota.service.js')
  return consumeQuota(userOrId, options)
}

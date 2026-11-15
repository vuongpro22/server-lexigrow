import mongoose from 'mongoose'
import SubscriptionPlan from '../models/SubscriptionPlan.js'
import Subscription from '../models/Subscription.js'
import PaymentTransaction from '../models/PaymentTransaction.js'
import User from '../models/User.js'
import ErrorResponse from '../utils/ErrorResponse.js'
import asyncHandler from '../utils/asyncHandler.js'
import { logAction } from '../utils/auditLogger.js'
import { renewalEndDate } from '../utils/subscriptionDates.js'
import { createHash, randomInt } from 'node:crypto'

const MAX_GRANT_DAYS = 3650

// SubscriptionPlan only enforces `min: 0` at the schema level, and Number('abc')
// is NaN — which Mongoose casts to null instead of rejecting. Validate here so a
// typo in the admin form cannot silently create a plan without a price.
const NUMERIC_PLAN_FIELDS = [
  'monthlyPrice', 'yearlyPrice', 'maxSponsoredStudents',
  'maxClasses', 'dailyAiEssayLimit', 'sortOrder',
]

const INTEGER_PLAN_FIELDS = new Set(['maxSponsoredStudents', 'maxClasses', 'dailyAiEssayLimit', 'sortOrder'])
const numericInputError = (field, integer = false) => new ErrorResponse(
  `${field} phải là ${integer ? 'số nguyên' : 'một số hợp lệ'}.`,
  400,
  integer ? 'PLAN_FIELD_NOT_INTEGER' : 'PLAN_FIELD_NOT_NUMERIC'
)

const assertYearlyPrice = (monthlyPrice, yearlyPrice) => {
  if (monthlyPrice > 0 && yearlyPrice > monthlyPrice * 12) {
    throw new ErrorResponse('Yearly price must not exceed twelve monthly payments.', 400, 'YEARLY_PRICE_EXCEEDS_MONTHLY_TOTAL')
  }
}

const parsePlanNumber = (field, raw) => {
  if (raw === null || (typeof raw === 'string' && raw.trim() === '')) {
    throw numericInputError(field)
  }
  const num = Number(raw)
  if (!Number.isFinite(num)) {
    throw numericInputError(field)
  }
  if (INTEGER_PLAN_FIELDS.has(field) && !Number.isInteger(num)) {
    throw numericInputError(field, true)
  }
  return num
}

/**
 * @desc    Admin: Get all pricing plans
 * @route   GET /api/admin/pricing/plans
 * @access  Private (Admin)
 */
export const adminGetPlans = asyncHandler(async (req, res) => {
  const plans = await SubscriptionPlan.find().sort({ targetRole: 1, sortOrder: 1, monthlyPrice: 1 })
  res.status(200).json({ success: true, count: plans.length, data: plans })
})

/**
 * @desc    Admin: Create a new plan
 * @route   POST /api/admin/pricing/plans
 * @access  Private (Admin)
 */
export const adminCreatePlan = asyncHandler(async (req, res) => {
  const { slug, name, description, targetRole, tier, monthlyPrice, yearlyPrice, features, maxSponsoredStudents, maxClasses, dailyAiEssayLimit, highlightBadge, sortOrder, isActive } = req.body

  if (!slug || !name || !targetRole || !tier || monthlyPrice === undefined || yearlyPrice === undefined) {
    throw new ErrorResponse('Vui lòng điền đầy đủ các thông tin bắt buộc.', 400, 'PLAN_FIELDS_REQUIRED')
  }

  const existing = await SubscriptionPlan.findOne({ slug })
  if (existing) {
    throw new ErrorResponse(`Gói cước với mã slug "${slug}" đã tồn tại.`, 400, 'PLAN_SLUG_EXISTS')
  }

  const parsedMonthlyPrice = parsePlanNumber('monthlyPrice', monthlyPrice)
  const parsedYearlyPrice = parsePlanNumber('yearlyPrice', yearlyPrice)
  assertYearlyPrice(parsedMonthlyPrice, parsedYearlyPrice)
  const plan = await SubscriptionPlan.create({
    slug,
    name,
    description: description || '',
    targetRole,
    tier,
    monthlyPrice: parsedMonthlyPrice,
    yearlyPrice: parsedYearlyPrice,
    features: Array.isArray(features) ? features.map(item => String(item).trim()).filter(Boolean) : [],
    maxSponsoredStudents: maxSponsoredStudents === undefined ? 0 : parsePlanNumber('maxSponsoredStudents', maxSponsoredStudents),
    maxClasses: maxClasses === undefined ? 1 : parsePlanNumber('maxClasses', maxClasses),
    dailyAiEssayLimit: dailyAiEssayLimit === undefined || dailyAiEssayLimit === null || dailyAiEssayLimit === '' ? 3 : parsePlanNumber('dailyAiEssayLimit', dailyAiEssayLimit),
    highlightBadge: highlightBadge || '',
    sortOrder: sortOrder === undefined ? 0 : parsePlanNumber('sortOrder', sortOrder),
    isActive: isActive !== false,
  })

  await logAction(req.user._id, 'ADMIN_CREATE_PLAN', 'SubscriptionPlan', plan._id, { name, slug })
  res.status(201).json({ success: true, data: plan })
})

/**
 * @desc    Admin: Update pricing plan
 * @route   PUT /api/admin/pricing/plans/:id
 * @access  Private (Admin)
 */
export const adminUpdatePlan = asyncHandler(async (req, res) => {
  const plan = await SubscriptionPlan.findById(req.params.id)
  if (!plan) {
    throw new ErrorResponse('Gói cước không tồn tại.', 404, 'PLAN_NOT_FOUND')
  }

  const allowedFields = [
    'name', 'description', 'monthlyPrice', 'yearlyPrice',
    'features', 'maxSponsoredStudents', 'maxClasses',
    'dailyAiEssayLimit', 'highlightBadge', 'isActive', 'sortOrder'
  ]

  allowedFields.forEach((field) => {
    if (req.body[field] === undefined) return
    const raw = req.body[field]
    if (field === 'features') {
      if (!Array.isArray(raw)) throw new ErrorResponse('Features must be a list', 400)
      plan.features = raw.map(item => String(item).trim()).filter(Boolean)
    } else if (field === 'dailyAiEssayLimit') {
      plan[field] = raw === '' || raw === null ? 3 : parsePlanNumber(field, raw)
    } else if (NUMERIC_PLAN_FIELDS.includes(field)) {
      plan[field] = parsePlanNumber(field, raw)
    } else {
      plan[field] = raw
    }
  })

  assertYearlyPrice(plan.monthlyPrice, plan.yearlyPrice)
  await plan.save()
  if (req.body.maxSponsoredStudents !== undefined) {
    await Subscription.updateMany(
      { $or: [{ plan: plan._id }, { planSlug: plan.slug }], status: 'active' },
      { $set: { maxSponsoredStudents: plan.maxSponsoredStudents } }
    )
  }
  await logAction(req.user._id, 'ADMIN_UPDATE_PLAN', 'SubscriptionPlan', plan._id, { name: plan.name, slug: plan.slug })

  res.status(200).json({ success: true, data: plan })
})

/**
 * @desc    Admin: Delete a plan
 * @route   DELETE /api/admin/pricing/plans/:id
 * @access  Private (Admin)
 */
export const adminDeletePlan = asyncHandler(async (req, res) => {
  const plan = await SubscriptionPlan.findById(req.params.id)
  if (!plan) {
    throw new ErrorResponse('Gói cước không tồn tại.', 404, 'PLAN_NOT_FOUND')
  }

  // Deleting a plan that rows still point at would leave dangling references.
  // Hide it instead (isActive = false), which the pricing and payment paths
  // already respect.
  const [subscriptionCount, transactionCount] = await Promise.all([
    Subscription.countDocuments({ plan: plan._id }),
    PaymentTransaction.countDocuments({ plan: plan._id }),
  ])

  if (subscriptionCount > 0 || transactionCount > 0) {
    throw new ErrorResponse(
      `Không thể xóa gói cước "${plan.name}": đang có ${subscriptionCount} đăng ký và ` +
      `${transactionCount} giao dịch tham chiếu tới gói này. Hãy tắt "isActive" để ẩn gói thay vì xóa.`,
      409,
      'PLAN_IN_USE'
    )
  }

  await SubscriptionPlan.deleteOne({ _id: plan._id })
  await logAction(req.user._id, 'ADMIN_DELETE_PLAN', 'SubscriptionPlan', plan._id, { slug: plan.slug })

  res.status(200).json({ success: true, message: 'Đã xóa gói cước thành công.' })
})

/**
 * @desc    Admin: Get all payment transactions
 * @route   GET /api/admin/pricing/transactions
 * @access  Private (Admin)
 */
export const adminGetTransactions = asyncHandler(async (req, res) => {
  const { status, page = 1, limit = 50 } = req.query
  const query = {}
  if (status) query.status = status

  const pageNum = Math.max(1, parseInt(page, 10) || 1)
  const limitNum = Math.max(1, Math.min(100, parseInt(limit, 10) || 50))

  const transactions = await PaymentTransaction.find(query)
    .populate('user', 'name email role')
    .sort({ createdAt: -1 })
    .skip((pageNum - 1) * limitNum)
    .limit(limitNum)

  const total = await PaymentTransaction.countDocuments(query)

  // Calculate revenue
  const revenueStats = await PaymentTransaction.aggregate([
    { $match: { status: 'PAID' } },
    { $group: { _id: null, totalRevenue: { $sum: '$amount' }, count: { $sum: 1 } } }
  ])

  res.status(200).json({
    success: true,
    count: transactions.length,
    total,
    page: pageNum,
    pages: Math.ceil(total / limitNum) || 1,
    totalRevenue: revenueStats[0]?.totalRevenue || 0,
    paidCount: revenueStats[0]?.count || 0,
    data: transactions,
  })
})

/**
 * @desc    Admin: Get all active/expired subscriptions
 * @route   GET /api/admin/pricing/subscriptions
 * @access  Private (Admin)
 */
export const adminGetSubscriptions = asyncHandler(async (req, res) => {
  const { status, tier } = req.query
  const page = Math.max(1, parseInt(req.query.page, 10) || 1)
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 30))
  const query = {}
  if (status) query.status = status
  if (tier) query.tier = tier

  const subscriptions = await Subscription.find(query)
    .populate('user', 'name email role')
    .populate('plan', 'name slug')
    .sort({ createdAt: -1 })
    .skip((page - 1) * limit)
    .limit(limit)

  const total = await Subscription.countDocuments(query)
  res.status(200).json({ success: true, count: subscriptions.length, total, page, pages: Math.ceil(total / limit) || 1, data: subscriptions })
})

/**
 * @desc    Admin: Manually grant/activate subscription for a user
 * @route   POST /api/admin/pricing/grant-subscription
 * @access  Private (Admin)
 */
export const adminGrantSubscription = asyncHandler(async (req, res) => {
  const { userId, planSlug, durationDays = 30 } = req.body

  if (!userId || !String(userId).trim()) {
    throw new ErrorResponse('Vui lòng cung cấp User ID hoặc Email.', 400, 'GRANT_USER_REQUIRED')
  }
  if (!planSlug) {
    throw new ErrorResponse('Vui lòng chọn gói cước.', 400, 'GRANT_PLAN_REQUIRED')
  }

  const days = Number(durationDays)
  if (!Number.isInteger(days) || days < 1 || days > MAX_GRANT_DAYS) {
    throw new ErrorResponse(`Thời hạn phải là số nguyên từ 1 đến ${MAX_GRANT_DAYS} ngày.`, 400, 'GRANT_DAYS_INVALID')
  }

  // Resolve the request before checking the key so a retry can only replay the
  // same actor + user + plan + duration request, never another grant's result.
  const identifier = String(userId).trim()
  let user = null
  if (mongoose.Types.ObjectId.isValid(identifier)) {
    user = await User.findById(identifier)
  }
  if (!user) {
    user = await User.findOne({ email: identifier.toLowerCase() })
  }
  if (!user) throw new ErrorResponse('Người dùng không tồn tại.', 404, 'GRANT_USER_NOT_FOUND')
  if (user.accountStatus !== 'active') throw new ErrorResponse('Tài khoản người dùng không hoạt động.', 400, 'GRANT_USER_INACTIVE')

  const plan = await SubscriptionPlan.findOne({ slug: planSlug })
  if (!plan) throw new ErrorResponse('Gói cước không tồn tại.', 404, 'PLAN_NOT_FOUND')
  if (!plan.isActive) throw new ErrorResponse('Gói cước đã bị ẩn.', 400, 'PLAN_INACTIVE')
  if (plan.tier === 'free') throw new ErrorResponse('Không thể cấp thủ công gói miễn phí.', 400, 'PLAN_FREE')
  if (plan.targetRole !== user.role) throw new ErrorResponse('Gói cước không phù hợp vai trò người dùng.', 400, 'PLAN_ROLE_MISMATCH')

  const idempotencyKey = String(req.get('Idempotency-Key') || '').trim().slice(0, 200) || null
  const requestFingerprint = createHash('sha256')
    .update(JSON.stringify({ actorId: String(req.user._id), userId: String(user._id), planId: String(plan._id), days }))
    .digest('hex')
  if (idempotencyKey) {
    const previous = await Subscription.findOne({ idempotencyKey })
    if (previous) {
      const sameRequest = previous.requestFingerprint === requestFingerprint
      if (!sameRequest) {
        throw new ErrorResponse('Idempotency-Key đã được dùng cho một yêu cầu cấp gói khác.', 409, 'IDEMPOTENCY_KEY_CONFLICT')
      }
      return res.status(200).json({ success: true, replayed: true, data: previous })
    }
  }

  const startDate = new Date()

  const activePaid = await Subscription.findOne({
    user: user._id, status: 'active', amountPaid: { $gt: 0 }, endDate: { $gt: startDate },
  })
  if (activePaid) {
    throw new ErrorResponse('Người dùng vẫn còn gói đã thanh toán. Không thể cấp gói thủ công khi gói đó còn hiệu lực.', 409, 'ACTIVE_PAID_SUBSCRIPTION')
  }

  const activeFreeQuery = Subscription.findOne({
    user: user._id,
    targetRole: plan.targetRole,
    amountPaid: 0,
    status: 'active',
    endDate: { $gt: startDate },
  })
  const activeFree = await (typeof activeFreeQuery?.sort === 'function'
    ? activeFreeQuery.sort({ endDate: -1 })
    : activeFreeQuery)
  const endDate = renewalEndDate(startDate, activeFree?.endDate, days)

  let subscription
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      subscription = await Subscription.create({
        user: user._id,
        plan: plan._id,
        planSlug: plan.slug,
        targetRole: plan.targetRole,
        tier: plan.tier,
        billingCycle: days >= 365 ? 'yearly' : 'monthly',
        amountPaid: 0,
        orderCode: randomInt(1_000_000_000, 2_000_000_000),
        startDate,
        endDate,
        status: 'active',
        maxSponsoredStudents: plan.maxSponsoredStudents || 0,
        idempotencyKey,
        requestFingerprint,
        grantedBy: req.user._id,
      })
      break
    } catch (error) {
      if (error.code !== 11000) throw error
      // A duplicate idempotency key means a concurrent request won the race.
      if (idempotencyKey) {
        const winner = await Subscription.findOne({ idempotencyKey })
        if (winner) {
          if (winner.requestFingerprint !== requestFingerprint) {
            throw new ErrorResponse('Idempotency-Key đã được dùng cho một yêu cầu cấp gói khác.', 409, 'IDEMPOTENCY_KEY_CONFLICT')
          }
          return res.status(200).json({ success: true, replayed: true, data: winner })
        }
      }
    }
  }
  if (!subscription) throw new ErrorResponse('Không thể tạo mã cấp gói duy nhất. Vui lòng thử lại.', 503, 'ORDER_CODE_UNAVAILABLE')

  // Deactivate previous active subscriptions after the new one is safely created
  await Subscription.updateMany(
    { user: user._id, targetRole: plan.targetRole, amountPaid: 0, _id: { $ne: subscription._id }, status: 'active' },
    { status: 'expired' }
  )

  await logAction(req.user._id, 'ADMIN_MANUALLY_GRANT_SUBSCRIPTION', 'Subscription', subscription._id, {
    grantedToUser: user.email,
    planSlug: plan.slug,
    durationDays,
  })

  res.status(201).json({ success: true, data: subscription })
})

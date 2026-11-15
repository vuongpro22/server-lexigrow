import SubscriptionPlan from '../models/SubscriptionPlan.js'
import Subscription from '../models/Subscription.js'
import PaymentTransaction from '../models/PaymentTransaction.js'
import Class from '../models/Class.js'
import User from '../models/User.js'
import ParentStudentLink from '../models/ParentStudentLink.js'
import ErrorResponse from '../utils/ErrorResponse.js'
import asyncHandler from '../utils/asyncHandler.js'
import { createPayOSPaymentLink, verifyPayOSWebhookData } from '../services/payos.service.js'
import { createManyNotifications } from '../services/notification.service.js'
import { getUserEffectiveTier } from '../services/tier.service.js'
import { logAction } from '../utils/auditLogger.js'
import mongoose from 'mongoose'
import { renewalEndDate } from '../utils/subscriptionDates.js'
import { findBestActiveSubscription, tierRank } from '../utils/subscriptionTier.js'

/**
 * @desc    Get all active subscription plans
 * @route   GET /api/payments/plans
 * @access  Public
 */
export const getPlans = asyncHandler(async (req, res) => {
  const { role } = req.query
  const query = { isActive: true }
  if (role && ['student', 'teacher'].includes(role)) {
    query.targetRole = role
  }

  const plans = await SubscriptionPlan.find(query).sort({ targetRole: 1, sortOrder: 1, monthlyPrice: 1 })
  res.status(200).json({ success: true, count: plans.length, data: plans })
})

/**
 * @desc    Get current user's effective subscription and tier details
 * @route   GET /api/payments/my-subscription
 * @access  Private
 */
export const getMySubscription = asyncHandler(async (req, res) => {
  const tierInfo = await getUserEffectiveTier(req.user)
  res.status(200).json({ success: true, data: tierInfo })
})

/**
 * Parents may buy a student plan for an actively linked child. The child is the
 * subscription beneficiary; the parent is the payer.
 */
async function resolvePaymentTarget(buyer, studentId) {
  if (buyer.role === 'parent') {
    if (!studentId) {
      throw new ErrorResponse('Vui lòng chọn học sinh cần mua gói.', 400)
    }
    if (!mongoose.isValidObjectId(studentId)) {
      throw new ErrorResponse('Học sinh không hợp lệ.', 400)
    }
    const link = await ParentStudentLink.findOne({
      parent: buyer._id,
      student: studentId,
      status: 'active',
    })
    if (!link) {
      throw new ErrorResponse('Bạn chỉ có thể mua gói cho học sinh đã liên kết.', 403)
    }
    const child = await User.findById(studentId).select('name email role accountStatus englishLevel')
    if (!child || child.role !== 'student') {
      throw new ErrorResponse('Học sinh không tồn tại.', 404)
    }
    if (child.accountStatus && child.accountStatus !== 'active') {
      throw new ErrorResponse('Tài khoản học sinh hiện không hoạt động.', 403)
    }
    return { targetUser: child, targetRole: 'student', purchasedBy: buyer._id }
  }

  if (studentId) {
    throw new ErrorResponse('Chỉ tài khoản phụ huynh mới có thể mua gói cho học sinh khác.', 403)
  }
  if (!['student', 'teacher'].includes(buyer.role)) {
    throw new ErrorResponse('Tài khoản này không thể mua gói cước.', 403)
  }
  return { targetUser: buyer, targetRole: buyer.role, purchasedBy: buyer._id }
}

/**
 * @desc    Get a linked child's current subscription
 * @route   GET /api/payments/children/:studentId/subscription
 * @access  Private (parent)
 */
export const getChildSubscription = asyncHandler(async (req, res) => {
  if (req.user.role !== 'parent') {
    throw new ErrorResponse('Chỉ phụ huynh mới có quyền xem gói của học sinh.', 403)
  }
  if (!mongoose.isValidObjectId(req.params.studentId)) {
    throw new ErrorResponse('Học sinh không hợp lệ.', 400)
  }

  const link = await ParentStudentLink.findOne({
    parent: req.user._id,
    student: req.params.studentId,
    status: 'active',
  })
  if (!link) {
    throw new ErrorResponse('Bạn chỉ có thể xem gói của học sinh đã liên kết.', 403)
  }

  const child = await User.findOne({
    _id: req.params.studentId,
    role: 'student',
  }).select('name email englishLevel accountStatus avatar')
  if (!child) {
    throw new ErrorResponse('Học sinh không tồn tại.', 404)
  }

  const now = new Date()
  const [tierInfo, activeSubscriptions] = await Promise.all([
    getUserEffectiveTier(child),
    Subscription.find({
      user: child._id,
      targetRole: 'student',
      status: 'active',
      startDate: { $lte: now },
      endDate: { $gte: now },
    })
      .select('tier planSlug billingCycle startDate endDate amountPaid')
      .sort({ endDate: -1 })
      .lean(),
  ])

  res.status(200).json({
    success: true,
    data: {
      child,
      tierInfo,
      activeSubscriptions,
    },
  })
})

/**
 * @desc    Create a PayOS payment link for subscription
 * @route   POST /api/payments/create-payment-link
 * @access  Private
 */
export const createPayment = asyncHandler(async (req, res) => {
  const { planSlug, billingCycle = 'monthly', studentId } = req.body

  if (!planSlug) {
    throw new ErrorResponse('Vui lòng chọn gói cước (planSlug).', 400)
  }

  if (!['monthly', 'yearly'].includes(billingCycle)) {
    throw new ErrorResponse('Chu kỳ thanh toán không hợp lệ (monthly hoặc yearly).', 400)
  }

  const { targetUser, targetRole, purchasedBy } = await resolvePaymentTarget(req.user, studentId)

  const plan = await SubscriptionPlan.findOne({ slug: planSlug, isActive: true })
  if (!plan) {
    throw new ErrorResponse('Gói cước không tồn tại hoặc đã ngừng cung cấp.', 404)
  }

  // A plan must match the beneficiary's role, not the payer's role. This lets a
  // parent buy a Student plan for their child while still blocking teacher
  // plans from a parent account.
  if (plan.targetRole !== targetRole) {
    throw new ErrorResponse(
      targetRole === 'teacher'
        ? 'Tài khoản Giáo viên vui lòng chọn gói dành cho Giáo viên.'
        : 'Tài khoản Học sinh vui lòng chọn gói dành cho Học sinh.',
      400,
    )
  }

  const amount = billingCycle === 'yearly' ? plan.yearlyPrice : plan.monthlyPrice
  if (amount <= 0) {
    throw new ErrorResponse('Gói cước miễn phí không cần thanh toán.', 400)
  }

  if (req.user.role === 'parent') {
    const currentTier = await getUserEffectiveTier(targetUser)
    const currentRank = tierRank(currentTier?.tier)
    const planRank = tierRank(plan.tier)
    if (planRank < currentRank) {
      throw new ErrorResponse('Gói này thấp hơn gói hiện tại của con.', 400, 'PLAN_NOT_AN_UPGRADE')
    }
    if (planRank === currentRank && currentTier?.source === 'teacher_sponsored') {
      throw new ErrorResponse('Con đang được giáo viên tài trợ ở gói này. Chỉ gói cao hơn mới thêm quyền lợi.', 400, 'PLAN_ALREADY_SPONSORED')
    }
  }

  // Generate a collision-safe orderCode: timestamp in ms (13 digits) is already within JS safe int range
  // and unique enough without DB lookup for concurrent requests
  const orderCode = Date.now() * 1000 + Math.floor(Math.random() * 1000)

  const clientUrl = process.env.CLIENT_URL || 'http://localhost:5173'
  const returnUrl = `${clientUrl}/payment/success?orderCode=${orderCode}`
  const cancelUrl = `${clientUrl}/payment/cancel?orderCode=${orderCode}`

  const cycleText = billingCycle === 'yearly' ? '1 Năm' : '1 Tháng'
  const description = `${plan.tier.toUpperCase()} ${cycleText}`.substring(0, 25)

  // 1. Save PENDING transaction first — if PayOS call fails, we clean up; never create orphan links
  const transaction = await PaymentTransaction.create({
    orderCode,
    user: targetUser._id,
    purchasedBy,
    plan: plan._id,
    planSlug: plan.slug,
    planName: plan.name,
    tier: plan.tier,
    targetRole: plan.targetRole,
    billingCycle,
    amount,
    status: 'PENDING',
    payosPaymentLinkId: '',
    checkoutUrl: '',
    qrCode: '',
  })

  let payosResponse
  try {
    // 2. Call PayOS API after DB record exists
    payosResponse = await createPayOSPaymentLink({
      orderCode,
      amount,
      description,
      buyerName: req.user.name,
      buyerEmail: req.user.email,
      returnUrl,
      cancelUrl,
      items: [
        {
          name: `${plan.name} (${cycleText})`,
          quantity: 1,
          price: amount,
        },
      ],
    })
  } catch (payosErr) {
    // PayOS failed — remove the PENDING record to avoid orphan transactions
    await PaymentTransaction.deleteOne({ _id: transaction._id })
    throw new ErrorResponse(`PayOS error: ${payosErr.message}`, 502)
  }

  // 3. Update transaction with PayOS link details
  await PaymentTransaction.findByIdAndUpdate(transaction._id, {
    $set: {
      payosPaymentLinkId: payosResponse.paymentLinkId || '',
      checkoutUrl: payosResponse.checkoutUrl,
      qrCode: payosResponse.qrCode,
    },
  })

  await logAction(req.user._id, 'CREATE_PAYMENT_LINK', 'PaymentTransaction', transaction._id, {
    orderCode,
    amount,
    planSlug,
    billingCycle,
    beneficiaryId: targetUser._id,
  })

  res.status(200).json({
    success: true,
    data: {
      orderCode,
      amount,
      checkoutUrl: payosResponse.checkoutUrl,
      qrCode: payosResponse.qrCode,
      planName: plan.name,
      billingCycle,
      beneficiary: {
        _id: targetUser._id,
        name: targetUser.name,
      },
    },
  })
})

/**
 * Send in-app notifications after a plan is activated. For a parent purchase
 * the child receives the plan notification and the parent receives a receipt
 * notification. Failures must never roll back an already-paid subscription.
 */
async function notifySubscriptionActivated(claimed, subscription) {
  try {
    const isParentPurchase = claimed.purchasedBy
      && String(claimed.purchasedBy) !== String(claimed.user)

    const notifications = isParentPurchase
      ? [
          {
            recipient: claimed.user,
            sender: claimed.purchasedBy,
            title: 'Learning plan upgraded',
            message: `Your parent upgraded your plan to ${claimed.planName}.`,
            type: 'system',
            link: '/student/dashboard',
          },
          {
            recipient: claimed.purchasedBy,
            sender: null,
            title: 'Payment successful',
            message: `The ${claimed.planName} plan is now active for your child.`,
            type: 'system',
            link: '/parent/plans',
          },
        ]
      : [
          {
            recipient: claimed.user,
            sender: null,
            title: 'Subscription activated',
            message: `Your ${claimed.planName} plan is now active${subscription.endDate ? ` until ${new Date(subscription.endDate).toLocaleDateString('en-GB')}` : ''}.`,
            type: 'system',
            link: claimed.targetRole === 'teacher' ? '/teacher/dashboard' : '/student/dashboard',
          },
        ]

    await createManyNotifications(notifications)
  } catch (error) {
    console.error('[Payment] Failed to send activation notifications:', error.message)
  }
}

/**
 * @desc    PayOS Webhook handler (handles payment confirmation)
 * @route   POST /api/payments/payos-webhook
 * @access  Public (Signature Verified)
 */
export async function activatePaidTransaction(orderCodeNum, verifiedData) {
  const existing = await PaymentTransaction.findOne({ orderCode: orderCodeNum })
  if (!existing || existing.status === 'PAID') return null
  if (verifiedData.amount !== undefined && Number(verifiedData.amount) !== existing.amount) {
    throw new ErrorResponse('Amount mismatch', 400, 'PAYMENT_AMOUNT_MISMATCH')
  }

  const plan = await SubscriptionPlan.findById(existing.plan)
  const durationDays = existing.billingCycle === 'yearly' ? 365 : 30
  const startDate = new Date()
  const activate = async (tx) => {
    const sessionOpt = tx ? { session: tx } : {}
    const claimed = await PaymentTransaction.findOneAndUpdate(
      { orderCode: orderCodeNum, status: { $in: ['PENDING', 'ACTIVATING'] } },
      { $set: { status: 'ACTIVATING', paidAt: existing.paidAt || new Date(), webhookData: verifiedData } },
      { new: true, ...sessionOpt },
    )
    if (!claimed) return null
    const priorSubscriptionQuery = Subscription.findOne({ activationTransaction: claimed._id })
    const priorSubscription = tx ? await priorSubscriptionQuery.session(tx) : await priorSubscriptionQuery
    if (priorSubscription) {
      // PAY-05: only expire previous active subscriptions of the same tier so distinct
      // active tiers stay concurrent and getUserEffectiveTier resolves the highest tier.
      await Subscription.updateMany(
        { user: claimed.user, targetRole: claimed.targetRole, tier: claimed.tier, status: 'active', _id: { $ne: priorSubscription._id } },
        { status: 'expired' },
        sessionOpt,
      )
      await PaymentTransaction.updateOne(
        { _id: claimed._id, status: 'ACTIVATING' },
        { $set: { status: 'PAID' } },
        sessionOpt,
      )
      return { subscription: priorSubscription, claimed }
    }
    const previousQuery = Subscription.findOne({
      user: claimed.user,
      targetRole: claimed.targetRole,
      tier: claimed.tier,
      status: 'active',
      endDate: { $gt: startDate },
    }).sort({ endDate: -1 })
    const previous = tx ? await previousQuery.session(tx) : await previousQuery
    const endDate = renewalEndDate(startDate, previous?.endDate, durationDays)
    const [subscription] = await Subscription.create([{
      user: claimed.user,
      plan: claimed.plan,
      planSlug: claimed.planSlug,
      targetRole: claimed.targetRole,
      tier: claimed.tier,
      billingCycle: claimed.billingCycle,
      amountPaid: claimed.amount,
      orderCode: claimed.orderCode,
      activationTransaction: claimed._id,
      startDate,
      endDate,
      status: 'active',
      maxSponsoredStudents: plan?.maxSponsoredStudents || 0,
      payosTransactionId: verifiedData.reference || '',
    }], sessionOpt)
    await Subscription.updateMany(
      { user: claimed.user, targetRole: claimed.targetRole, tier: claimed.tier, status: 'active', _id: { $ne: subscription._id } },
      { status: 'expired' },
      sessionOpt,
    )
    await PaymentTransaction.updateOne(
      { _id: claimed._id, status: 'ACTIVATING' },
      { $set: { status: 'PAID' } },
      sessionOpt,
    )
    return { subscription, claimed }
  }

  let result = null
  let session = null
  try {
    session = await mongoose.startSession()
    await session.withTransaction(async () => { result = await activate(session) })
  } catch (err) {
    const unsupported = err.code === 20 || (typeof err.message === 'string' && (
      err.message.includes('Transaction numbers are only allowed on a replica set') ||
      err.message.includes('does not support retryable writes') ||
      err.message.includes('Transaction is not supported')
    ))
    if (!unsupported) {
      if (err.code === 11000) return null
      throw err
    }
    console.warn('[PayOS] MongoDB transaction unsupported; using resumable activation')
    try {
      result = await activate(null)
    } catch (fallbackErr) {
      if (fallbackErr.code === 11000) return null
      throw fallbackErr
    }
  } finally {
    if (session) await session.endSession()
  }

  if (result) {
    const { subscription, claimed } = result
    await logAction(claimed.purchasedBy || claimed.user, 'PAYMENT_SUCCESS_ACTIVATE_SUBSCRIPTION', 'Subscription', subscription._id, {
      orderCode: claimed.orderCode,
      tier: claimed.tier,
      billingCycle: claimed.billingCycle,
      endDate: subscription.endDate,
      beneficiaryId: claimed.user,
      purchasedBy: claimed.purchasedBy || null,
    })
    await notifySubscriptionActivated(claimed, subscription)
  }
  return result
}

export const payosWebhook = asyncHandler(async (req, res) => {
  const webhookBody = req.body

  // 1. Verify webhook signature
  let verifiedData
  try {
    verifiedData = await verifyPayOSWebhookData(webhookBody)
  } catch (err) {
    console.error('❌ PayOS Webhook signature verification failed:', err.message)
    return res.status(400).json({ success: false, message: 'Invalid webhook signature' })
  }

  if (!verifiedData) {
    return res.status(400).json({ success: false, message: 'No webhook data' })
  }

  const { orderCode, code, desc } = verifiedData
  console.log(`🔔 PayOS Webhook received for Order: ${orderCode}, Code: ${code}, Desc: ${desc}`)

  // Code '00' indicates successful payment in PayOS
  if (code === '00') {
    const orderCodeNum = Number(orderCode)

    try {
      const result = await activatePaidTransaction(orderCodeNum, verifiedData)
      if (!result) return res.status(200).json({ success: true, message: 'Already processed or unknown order' })
    } catch (err) {
      if (err.code === 'PAYMENT_AMOUNT_MISMATCH') {
        console.error(`PayOS amount mismatch for order ${orderCodeNum}`)
        return res.status(400).json({ success: false, message: 'Amount mismatch' })
      }
      throw err
    }
    console.log(`✅ Subscription activated for order ${orderCodeNum}`)
  }

  res.status(200).json({ success: true })
})

/**
 * @desc    Get teacher's sponsorship status (quota & list of sponsored students)
 * @route   GET /api/payments/teacher-sponsorship
 * @access  Private (Teacher)
 */
export const getTeacherSponsorshipStatus = asyncHandler(async (req, res) => {
  if (req.user.role !== 'teacher') {
    throw new ErrorResponse('Chỉ tài khoản Giáo viên mới có quyền xem thông tin này.', 403)
  }

  const now = new Date()
  const activeSub = await findBestActiveSubscription(Subscription, {
    user: req.user._id,
    targetRole: 'teacher',
    status: 'active',
    startDate: { $lte: now },
    endDate: { $gte: now },
  })

  const activePlan = activeSub?.planSlug
    ? await SubscriptionPlan.findOne({ slug: activeSub.planSlug })
    : null

  // Get all active classes taught by this teacher in deterministic order matching tier.service.js
  const classesQuery = Class.find({
    teacher: req.user._id,
    status: 'active',
  })
  const sortedClassesQuery = typeof classesQuery?.sort === 'function'
    ? classesQuery.sort({ createdAt: 1, _id: 1 })
    : classesQuery
  const classes = await sortedClassesQuery.populate('students', 'name email englishLevel')

  const uniqueStudentMap = new Map()
  classes.forEach((cls) => {
    cls.students.forEach((s) => {
      const id = s._id.toString()
      if (!uniqueStudentMap.has(id)) {
        uniqueStudentMap.set(id, {
          _id: s._id,
          name: s.name,
          email: s.email,
          englishLevel: s.englishLevel,
          className: cls.name,
        })
      }
    })
  })

  // The quota snapshotted when the teacher purchased the plan is the source of
  // truth. Falling back to the current plan is only for legacy subscriptions
  // that predate maxSponsoredStudents.
  const purchasedQuota = Number(activeSub?.maxSponsoredStudents)
  const maxQuota = activeSub
    ? Math.max(0, Number.isFinite(purchasedQuota) && purchasedQuota > 0
      ? purchasedQuota
      : (activePlan?.maxSponsoredStudents ?? purchasedQuota ?? 0))
    : 0
  const allUniqueStudents = Array.from(uniqueStudentMap.values())
  const sponsoredStudents = allUniqueStudents.slice(0, maxQuota)

  res.status(200).json({
    success: true,
    data: {
      hasActiveSubscription: !!activeSub,
      currentTier: activeSub?.tier || 'free',
      planName: activeSub ? `${activeSub.tier.toUpperCase()} Teacher Plan` : 'Chưa đăng ký gói',
      expiresAt: activeSub?.endDate || null,
      maxSponsoredQuota: maxQuota,
      usedQuota: sponsoredStudents.length,
      remainingQuota: Math.max(0, maxQuota - sponsoredStudents.length),
      sponsoredStudents,
    },
  })
})

/**
 * @desc    Get current user's transaction history
 * @route   GET /api/payments/my-transactions
 * @access  Private
 */
export const getMyTransactions = asyncHandler(async (req, res) => {
  const transactions = await PaymentTransaction.find({
    $or: [
      { user: req.user._id },
      { purchasedBy: req.user._id },
    ],
  })
    .sort({ createdAt: -1 })
    .limit(50)
    .populate('user', 'name')
  res.status(200).json({ success: true, count: transactions.length, data: transactions })
})

export const getMyPaymentStatus = asyncHandler(async (req, res) => {
  const orderCode = Number(req.params.orderCode)
  if (!Number.isSafeInteger(orderCode) || orderCode <= 0) {
    throw new ErrorResponse('Invalid order code', 400, 'INVALID_ORDER_CODE')
  }
  const transaction = await PaymentTransaction.findOne({
    orderCode,
    $or: [
      { user: req.user._id },
      { purchasedBy: req.user._id },
    ],
  })
    .select('orderCode status planName tier billingCycle amount createdAt paidAt user purchasedBy')
    .populate('user', 'name')
    .lean()
  if (!transaction) throw new ErrorResponse('Payment order not found', 404, 'PAYMENT_ORDER_NOT_FOUND')

  res.status(200).json({
    success: true,
    data: {
      ...transaction,
      beneficiary: transaction.user,
    },
  })
})

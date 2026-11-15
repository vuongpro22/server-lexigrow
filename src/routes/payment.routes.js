import { Router } from 'express'
import {
  getPlans,
  getMySubscription,
  getChildSubscription,
  createPayment,
  payosWebhook,
  getTeacherSponsorshipStatus,
  getMyTransactions,
  getMyPaymentStatus,
} from '../controllers/payment.controller.js'
import { protect, authorize } from '../middleware/auth.middleware.js'
import { payosWebhookLimiter } from '../middleware/rateLimit.middleware.js'

const router = Router()

// Public routes
router.get('/plans', getPlans)
router.post('/payos-webhook', payosWebhookLimiter, payosWebhook)

// Protected routes
router.use(protect)
router.get('/my-subscription', getMySubscription)
router.get('/children/:studentId/subscription', authorize('parent'), getChildSubscription)
router.get('/my-transactions', getMyTransactions)
router.get('/my-transactions/:orderCode', getMyPaymentStatus)
router.post('/create-payment-link', createPayment)
router.get('/teacher-sponsorship', authorize('teacher'), getTeacherSponsorshipStatus)

export default router

import { Router } from 'express'
import { getProfile, updateProfile, changePassword, updateNotifications, confirmEmailChange } from '../controllers/profile.controller.js'
import { emailChangeRequestLimiter, emailChangeVerifyLimiter } from '../middleware/rateLimit.middleware.js'
import { protect, authorize } from '../middleware/auth.middleware.js'
import { getLearningProfile, updateLearningProfile } from '../controllers/learningProfile.controller.js'

const router = Router()

router.use(protect)
router.route('/learning').get(authorize('student'), getLearningProfile).put(authorize('student'), updateLearningProfile)

router.route('/')
  .get(getProfile)
  .put(emailChangeRequestLimiter, updateProfile)

router.post('/email/confirm', emailChangeVerifyLimiter, confirmEmailChange)

router.put('/password', changePassword)
router.put('/notifications', updateNotifications)

export default router

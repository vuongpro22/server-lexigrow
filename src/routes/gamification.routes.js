import { Router } from 'express'
import { protect, authorize } from '../middleware/auth.middleware.js'
import asyncHandler from '../utils/asyncHandler.js'
import { getGamificationSummary } from '../services/gamification.service.js'

const router = Router()
router.use(protect, authorize('student'))

router.get(
  '/summary',
  asyncHandler(async (req, res) => {
    const data = await getGamificationSummary(req.user._id)
    res.json({ success: true, data })
  }),
)

export default router

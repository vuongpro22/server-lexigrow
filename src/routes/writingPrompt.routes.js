import { Router } from 'express'
import { protect, authorize } from '../middleware/auth.middleware.js'
import { aiLearningLimiter } from '../middleware/learningRateLimit.js'
import { getWritingPromptForSession } from '../controllers/writingPrompt.controller.js'

const router = Router()

// Tất cả endpoint writing-prompt yêu cầu student đăng nhập
router.use(protect, authorize('student'))

// GET /api/sessions/:id/writing-prompt
// Rate limit: 20/15min/user (gọi AI tốn cost)
router.get('/:id/writing-prompt', aiLearningLimiter, getWritingPromptForSession)

export default router

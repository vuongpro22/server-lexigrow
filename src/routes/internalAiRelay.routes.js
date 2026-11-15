import { Router } from 'express'
import { requireAIRelayService } from '../middleware/aiRelayAuth.middleware.js'
import { aiRelayLimiter } from '../middleware/learningRateLimit.js'
import { completeInternalAI } from '../controllers/internalAiRelay.controller.js'

const router = Router()
router.use(requireAIRelayService)
router.post('/complete', aiRelayLimiter, completeInternalAI)
export default router

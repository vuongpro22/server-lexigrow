import { Router } from 'express'
import { protect, authorize } from '../middleware/auth.middleware.js'
import {
  gamePlayRateLimiter,
  gameSubmitRateLimiter,
} from '../middleware/gameRateLimit.middleware.js'
import { finishGame, startGame, submitGameAnswer, heartbeatGame } from '../controllers/game.controller.js'

const router = Router()
router.use(protect, authorize('student'))

router.post('/:gameKey/sessions', gamePlayRateLimiter, startGame)
router.post('/:gameKey/sessions/:id/answers', gameSubmitRateLimiter, submitGameAnswer)
router.post('/:gameKey/sessions/:id/finish', gameSubmitRateLimiter, finishGame)
router.post('/:gameKey/sessions/:id/heartbeat', gameSubmitRateLimiter, heartbeatGame)

export default router

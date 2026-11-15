import { Router } from 'express'
import { protect, authorize } from '../middleware/auth.middleware.js'
import { aiLearningLimiter } from '../middleware/learningRateLimit.js'
import { getPracticeQuestionsForSession } from '../controllers/practiceQuestion.controller.js'

const router = Router()

// All practice questions endpoints require authenticated student
router.use(protect, authorize('student'))

// GET /api/sessions/:id/practice-questions
router.get('/:id/practice-questions', aiLearningLimiter, getPracticeQuestionsForSession)

export default router

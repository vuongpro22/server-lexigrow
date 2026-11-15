import { Router } from 'express'
import { protect, authorize } from '../middleware/auth.middleware.js'
import {
  startLearningSession,
  getCurrentSession,
  getSessionForEssay,
  reopenSessionForRevision,
  updateSessionStep,
  getLearningPathRecommendation,
  getTrialStatus,
} from '../controllers/learningSession.controller.js'
import {
  getLearningHistory,
  getRoundCounts,
} from '../controllers/learningHistory.controller.js'

const router = Router()
router.get('/round-counts', protect, authorize('student', 'admin'), getRoundCounts)
router.use(protect, authorize('student'))
router.post('/start', startLearningSession)
router.get('/current', getCurrentSession)
router.get('/by-essay/:essayId', getSessionForEssay)
router.patch('/:id/reopen-for-revision', reopenSessionForRevision)
router.put('/:id/step', updateSessionStep)
router.get('/recommendation', getLearningPathRecommendation)
router.get('/trial-status', getTrialStatus)
router.get('/history', getLearningHistory)
export default router

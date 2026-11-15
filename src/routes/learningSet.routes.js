import { Router } from 'express'
import {
  getLearningSets,
  getExploreLearningSets,
  getLearningSetBySlug,
  createLearningSet,
  updateLearningSet,
  deleteLearningSet
} from '../controllers/learningSet.controller.js'
import { protect, authorize, optionalAuth } from '../middleware/auth.middleware.js'

const router = Router()

// Public / Guest accessible explore route
router.get('/explore', optionalAuth, getExploreLearningSets)

router.route('/')
  .get(optionalAuth, getLearningSets)
  .post(protect, authorize('admin'), createLearningSet)

router.route('/:slug')
  .get(optionalAuth, getLearningSetBySlug)
  .put(protect, authorize('admin'), updateLearningSet)
  .delete(protect, authorize('admin'), deleteLearningSet)

export default router

import { Router } from 'express'
import {
  getGlobalVocabularies,
  getGlobalVocabularyById,
  createGlobalVocabulary,
  updateGlobalVocabulary,
  deleteGlobalVocabulary,
  importGlobalVocabularies,
  exportGlobalVocabularies,
  getGlobalVocabularyStats
} from '../controllers/globalVocabulary.controller.js'
import { protect, authorize } from '../middleware/auth.middleware.js'
import { adminLimiter } from '../middleware/rateLimit.middleware.js'

const router = Router()

router.use(protect)
router.use(authorize('admin'))
router.use(adminLimiter)

router.route('/')
  .get(getGlobalVocabularies)
  .post(createGlobalVocabulary)

router.post('/import', importGlobalVocabularies)
router.get('/export', exportGlobalVocabularies)
router.get('/stats', getGlobalVocabularyStats)

router.route('/:id')
  .get(getGlobalVocabularyById)
  .put(updateGlobalVocabulary)
  .delete(deleteGlobalVocabulary)

export default router

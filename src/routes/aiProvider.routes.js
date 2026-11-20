import { Router } from 'express'
import { protect, authorize } from '../middleware/auth.middleware.js'
import { adminLimiter } from '../middleware/rateLimit.middleware.js'
import {
  listAIProviders,
  createAIProvider,
  discoverAIProviderModels,
  updateAIProvider,
  deleteAIProvider,
  testAIProvider,
  addAIProviderKey,
  updateAIProviderKey,
  deleteAIProviderKey,
  testAIProviderKey,
  listAIModels,
  createAIModel,
  updateAIModel,
  deleteAIModel,
  listAICombos,
  createAICombo,
  updateAICombo,
  deleteAICombo,
  activateAICombo,
} from '../controllers/aiProvider.controller.js'

const router = Router()
router.use(protect, authorize('admin'))
router.use(adminLimiter)
router.get('/', listAIProviders)
router.post('/', createAIProvider)
router.post('/models/discover', discoverAIProviderModels)
router.get('/models', listAIModels)
router.post('/models', createAIModel)
router.patch('/models/:id', updateAIModel)
router.delete('/models/:id', deleteAIModel)
router.get('/combos', listAICombos)
router.post('/combos', createAICombo)
router.patch('/combos/:id', updateAICombo)
router.delete('/combos/:id', deleteAICombo)
router.post('/combos/:id/activate', activateAICombo)
router.patch('/:id', updateAIProvider)
router.delete('/:id', deleteAIProvider)
router.post('/:id/test', testAIProvider)
router.post('/:id/keys', addAIProviderKey)
router.patch('/:id/keys/:keyId', updateAIProviderKey)
router.delete('/:id/keys/:keyId', deleteAIProviderKey)
router.post('/:id/keys/:keyId/test', testAIProviderKey)
export default router

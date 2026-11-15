import { Router } from 'express'
import { protect, authorize } from '../middleware/auth.middleware.js'
import { getGardenStatus, waterGarden } from '../controllers/learningProgress.controller.js'
const router = Router()
router.use(protect, authorize('student'))
router.get('/status', getGardenStatus)
// Watering allows Free accounts 3/day (429 when exceeded), Plus 8/day, Pro 20/day inside waterGarden.
router.post('/water', waterGarden)
export default router

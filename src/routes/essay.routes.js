import { Router } from 'express'
import {
  createEssay, getEssays, getEssay,
  updateEssay, submitEssay, deleteEssay,
  getEssaysByStudent, getSuggestedTopics,
  requestRevision, getPasteConfig,
  runAIHelper,
} from '../controllers/essay.controller.js'
import { protect, authorize } from '../middleware/auth.middleware.js'
import { submitRevision, retryRevision, getRevisions } from '../controllers/essayRevision.controller.js'
import { aiLearningLimiter } from '../middleware/learningRateLimit.js'

const router = Router()

router.use(protect) // All essay routes require authentication
router.post('/submit-revision', authorize('student'), aiLearningLimiter, submitRevision)
router.post('/revisions/:revisionId/analyze', authorize('student'), aiLearningLimiter, retryRevision)
router.post('/:id/revisions', authorize('student'), aiLearningLimiter, submitRevision)
router.get('/:id/revisions', authorize('student'), getRevisions)

router.route('/')
  .post(authorize('student'), createEssay)
  // No role guard here: getEssays scopes the query with essayVisibilityFilter,
  // which is the single place deciding what each role may list. Guarding twice
  // let admin/teacher/parent 403 on a route the controller already handles.
  .get(getEssays)

router.post('/ai-helper', authorize('student'), aiLearningLimiter, runAIHelper)
router.get('/paste-config', authorize('student'), getPasteConfig)
router.get('/suggest-topics', authorize('student'), aiLearningLimiter, getSuggestedTopics)

router.route('/:id')
  .get(getEssay)
  .put(authorize('student'), updateEssay)
  .delete(authorize('student'), deleteEssay)

router.patch('/:id/submit', authorize('student'), aiLearningLimiter, submitEssay)
router.patch('/:id/request-revision', authorize('teacher'), requestRevision)

router.get('/student/:studentId', authorize('teacher'), getEssaysByStudent)

export default router

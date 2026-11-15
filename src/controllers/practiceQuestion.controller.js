import asyncHandler from '../utils/asyncHandler.js'
import ErrorResponse from '../utils/ErrorResponse.js'
import LearningSession from '../models/LearningSession.js'
import { generatePracticeQuestions } from '../services/practiceQuestion.service.js'

/**
 * @desc    Get AI-generated practice questions for a learning session
 * @route   GET /api/sessions/:id/practice-questions
 * @access  Private (student only)
 *
 * Query params:
 *   - bypassCache=1 (or refresh=1) : re-generates a brand new set of questions via AI
 */
export const getPracticeQuestionsForSession = asyncHandler(async (req, res) => {
  const session = await LearningSession.findOne({
    _id: req.params.id,
    student: req.user._id,
  })

  if (!session) {
    throw new ErrorResponse('Session not found', 404)
  }

  if (!session.targetWords || session.targetWords.length === 0) {
    throw new ErrorResponse('Session has no target words', 400)
  }

  const bypassCache =
    req.query.bypassCache === '1' ||
    req.query.bypassCache === 'true' ||
    req.query.refresh === '1'

  const result = await generatePracticeQuestions(session, { bypassCache })

  // LEARN-14 / ST-09: Loại bỏ correctAnswer và explanation khỏi response để chống lộ đáp án trước khi làm bài
  const sanitizedQuestions = (result.questions || []).map((q) => {
    const raw = typeof q.toObject === 'function' ? q.toObject() : { ...q }
    const { correctAnswer, explanation, ...safeQuestion } = raw
    return safeQuestion
  })

  res.json({
    success: true,
    data: {
      ...result,
      questions: sanitizedQuestions,
    },
  })
})

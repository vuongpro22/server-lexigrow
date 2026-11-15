/**
 * WritingPrompt Controller
 *
 * Endpoints:
 *  - GET /api/sessions/:id/writing-prompt  — sinh prompt cho 1 session
 *
 * Auth: student (chỉ student sở hữu session mới được xem)
 */

import asyncHandler from '../utils/asyncHandler.js'
import ErrorResponse from '../utils/ErrorResponse.js'
import LearningSession from '../models/LearningSession.js'
import {
  generateWritingPrompt,
  generateFallbackWritingPrompt,
} from '../services/writingPrompt.service.js'

/**
 * @desc    Get AI-generated writing prompt for a session
 * @route   GET /api/sessions/:id/writing-prompt
 * @access  Private (student) — chỉ chủ session
 *
 * Query params:
 *   - bypassCache=1  : bỏ qua cache, sinh prompt mới
 *
 * Trả về:
 *   {
 *     prompt: "Write a short paragraph...",
 *     wordTargets: ["apple", "banana", ...],
 *     wordCountMin, wordCountMax,
 *     fallback: bool,
 *     source: 'ai' | 'cache' | 'fallback',
 *     generatedAt: ISO date
 *   }
 */
export const getWritingPromptForSession = asyncHandler(async (req, res) => {
  const session = await LearningSession.findOne({
    _id: req.params.id,
    student: req.user._id,
  })
  if (!session) throw new ErrorResponse('Session not found', 404)

  if (!session.targetWords || session.targetWords.length === 0) {
    throw new ErrorResponse('Session has no target words', 400)
  }

  const bypassCache = req.query.bypassCache === '1' || req.query.bypassCache === 'true'

  try {
    const result = await generateWritingPrompt(session, { bypassCache })
    res.json({
      success: true,
      data: {
        ...result,
        // Serialize Date thành ISO string cho JSON
        generatedAt: result.generatedAt.toISOString(),
      },
    })
  } catch (err) {
    // Cuối cùng vẫn fail → trả fallback thẳng, không 500
    console.error('[WritingPrompt] Generation failed, using fallback:', err.message)
    const fallback = generateFallbackWritingPrompt(session)
    res.json({
      success: true,
      data: {
        ...fallback,
        generatedAt: fallback.generatedAt.toISOString(),
      },
    })
  }
})

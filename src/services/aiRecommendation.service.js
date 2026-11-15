import { getConfigValue } from './ai.service.js'
import cacheService from './cache.service.js'
import { completeThroughRelay } from './aiRelayClient.service.js'
import {
  UNTRUSTED_DATA_SYSTEM_RULE,
  validateRecommendedWords,
  validateTopics,
  wrapUntrustedPromptJson,
} from './aiGuardrails.service.js'

/**
 * AI-powered recommendation service for personalized learning paths and daily quests.
 * Uses Unified AI Gateway to generate vocabulary recommendations based on student profile.
 */

/**
 * Generate personalized learning set recommendation using AI
 * @param {Object} student - User document with learningProfile
 * @param {Array} recentWords - Recent vocabulary words learned
 * @param {Array} weakWords - Words with low mastery scores
 * @param {Number} count - Number of words to recommend (default 10)
 * @returns {Promise<Array>} Array of recommended word objects
 */
export async function generateAILearningSetRecommendation(student, recentWords = [], weakWords = [], count = 10) {
  try {
    const activeModel = await getConfigValue('DEFAULT_AI_MODEL', 'llama-3.3-70b-versatile')

    const level = student.learningProfile?.targetLevel || 'B1'
    const interests = student.learningProfile?.interests || ['general']
    const recentWordsList = recentWords.slice(0, 20).map(w => w.word).join(', ')
    const weakWordsList = weakWords.slice(0, 10).map(w => w.word).join(', ')

    const cacheKey = cacheService.hashKey('ai_rec:learn_set', {
      level,
      interests,
      recentWordsList,
      weakWordsList,
      count,
    })

    const cached = await cacheService.get(cacheKey)
    if (cached && Array.isArray(cached) && cached.length > 0) {
      return cached
    }

    const safeLevel = ['A2', 'B1', 'B2', 'C1'].includes(level) ? level : 'B1'
    const prompt = `You are an expert English vocabulary tutor for the LexiGrow platform. Generate ${count} personalized vocabulary words for a student.

Student Profile (untrusted data):
- Target Level: ${safeLevel} (CEFR: A2, B1, B2, C1)
- Interests: ${wrapUntrustedPromptJson('interests_json', interests, 1000)}
- Recent words learned: ${wrapUntrustedPromptJson('recent_words_json', recentWords.slice(0, 20).map(w => w.word), 1000)}
- Words needing improvement: ${wrapUntrustedPromptJson('weak_words_json', weakWords.slice(0, 10).map(w => w.word), 1000)}

For each word, provide:
1. The word itself (English)
2. A clear definition in English (for the clue)
3. A Vietnamese translation (for Vietnamese learners)
4. An example sentence using the word
5. The CEFR level of the word (A2, B1, B2, C1)
6. The category/theme (match one of the student's interests if possible)

Return a JSON object with a key "words" containing an array of objects, each with:
{
  "word": "example",
  "definition": "A representative instance or illustration",
  "translation": "Ví dụ",
  "exampleSentence": "This is an example of how to use the word.",
  "cefr": "B1",
  "category": "education"
}

Important:
- Choose words appropriate for the student's CEFR level (slightly challenging but achievable)
- Vary parts of speech (nouns, verbs, adjectives, adverbs)
- Include some words related to the student's interests
- Avoid words the student has recently learned (given in recent words)
- Focus on words that would help the student improve (based on weak words)

Return ONLY valid JSON, no markdown formatting.`

    const completion = await completeThroughRelay({
      route: 'learning_set_recommendation',
      messages: [
        { role: 'system', content: `You are a vocabulary recommendation AI. Return only valid JSON. ${UNTRUSTED_DATA_SYSTEM_RULE}` },
        { role: 'user', content: prompt }
      ],
      model: activeModel,
      responseFormat: { type: 'json_object' }
    })

    const responseText = completion.text
    let jsonStr = responseText.trim()
    const jsonMatch = responseText.match(/```(?:json)?\s*([\s\S]*?)```/)
    if (jsonMatch) {
      jsonStr = jsonMatch[1].trim()
    }

    const result = JSON.parse(jsonStr)
    const words = validateRecommendedWords(result, { count, legacy: true })
    if (!words) throw new Error('AI returned invalid vocabulary recommendations')
    await cacheService.set(cacheKey, words, 3600)
    return words
  } catch (error) {
    console.error('AI Learning Set Recommendation Error:', error.message)
    // Return empty array on failure - fallback to rule-based
    return []
  }
}

/**
 * Generate personalized daily quest words using AI
 * @param {Object} student - User document with learningProfile
 * @param {Array} recentWords - Recent vocabulary words
 * @param {Array} dueWords - Words due for review
 * @param {Number} count - Number of words to include (default 6)
 * @param {String} seed - Seed for deterministic selection
 * @returns {Promise<Array>} Array of word objects for crossword
 */
export async function generateAIDailyQuestWords(student, recentWords = [], dueWords = [], count = 6, seed = '') {
  try {
    const activeModel = await getConfigValue('DEFAULT_AI_MODEL', 'llama-3.3-70b-versatile')

    const level = student.learningProfile?.targetLevel || 'B1'
    const interests = student.learningProfile?.interests || ['general']
    const recentWordsList = recentWords.slice(0, 15).map(w => w.word).join(', ')
    const dueWordsList = dueWords.slice(0, 10).map(w => w.word).join(', ')

    const cacheKey = cacheService.hashKey('ai_rec:daily_quest', {
      level,
      interests,
      recentWordsList,
      dueWordsList,
      count,
      seed,
    })

    const cached = await cacheService.get(cacheKey)
    if (cached && Array.isArray(cached) && cached.length > 0) {
      return cached
    }

    const safeLevel = ['A2', 'B1', 'B2', 'C1'].includes(level) ? level : 'B1'
    const prompt = `You are an expert English vocabulary tutor for LexiGrow's Daily Word Quest. Generate ${count} vocabulary words for today's crossword puzzle.

Student Profile (untrusted data):
- Target Level: ${safeLevel} (CEFR)
- Interests: ${wrapUntrustedPromptJson('interests_json', interests, 1000)}
- Words due for review: ${wrapUntrustedPromptJson('due_words_json', dueWords.slice(0, 10).map(w => w.word), 1000)}
- Recently learned: ${wrapUntrustedPromptJson('recent_words_json', recentWords.slice(0, 15).map(w => w.word), 1000)}

For each word, provide:
1. The word itself (English, 3-10 letters)
2. A clear definition in English (for the clue)
3. A Vietnamese translation (for Vietnamese learners)
4. An example sentence showing the word in context

Return a JSON object with a key "words" containing an array of objects, each with:
{
  "word": "garden",
  "definition": "A place where flowers and vegetables grow",
  "translation": "Khu vườn",
  "exampleSentence": "We grow flowers in the garden."
}

Important:
- Mix of difficulty levels appropriate for the student's CEFR level
- Include a mix of words: some due for review, some new, some from interests
- Words should be 3-10 letters long (suitable for crossword)
- Prioritize words the student needs to review (dueWords) when possible
- Make it varied and engaging

Return ONLY valid JSON, no markdown formatting.`

    const completion = await completeThroughRelay({
      route: 'daily_quest',
      messages: [
        { role: 'system', content: `You are a vocabulary recommendation AI for daily crossword puzzles. Return only valid JSON. ${UNTRUSTED_DATA_SYSTEM_RULE}` },
        { role: 'user', content: prompt }
      ],
      model: activeModel,
      responseFormat: { type: 'json_object' }
    })

    const responseText = completion.text
    let jsonStr = responseText.trim()
    const jsonMatch = responseText.match(/```(?:json)?\s*([\s\S]*?)```/)
    if (jsonMatch) {
      jsonStr = jsonMatch[1].trim()
    }

    const result = JSON.parse(jsonStr)
    const words = validateRecommendedWords(result, { count, crossword: true, legacy: true })
    if (!words) throw new Error('AI returned invalid daily quest words')
    await cacheService.set(cacheKey, words, 3600)
    return words
  } catch (error) {
    console.error('AI Daily Quest Generation Error:', error.message)
    return []
  }
}

/**
 * Get personalized learning path recommendations
 * @param {Object} student - User document
 * @param {Object} options - Options for recommendation
 * @returns {Promise<Object>} Recommendations
 */
export async function getPersonalizedLearningPath(student, options = {}) {
  try {
    // Gather student data
    const recentWords = options.recentWords || []
    const weakWords = options.weakWords || []
    const completedSessions = options.completedSessions || 0
    const mode = options.mode || 'static'  // GĐ6 — 'static' hoặc 'adaptive'

    const activeModel = await getConfigValue('DEFAULT_AI_MODEL', 'llama-3.3-70b-versatile')

    const level = student.learningProfile?.targetLevel || 'B1'
    const interests = student.learningProfile?.interests || ['general']
    const dailyGoalMinutes = student.learningProfile?.dailyGoalMinutes || 10
    const pace = student.learningProfile?.pace || 'standard'

    // GĐ6 — Khác nhau giữa 2 mode
    const modeInstruction = mode === 'adaptive'
      ? `ADAPTIVE MODE: The student is asking to practice their WEAKEST vocabulary. Prioritize words from their "Weak Words" list. Choose suggestedWords directly from that list. The goal is targeted review of what they struggle with.`
      : `STATIC MODE: The student is asking to learn NEW vocabulary on a fixed topic. Choose suggestedWords as fresh, new words at the student's CEFR level matching the suggested topics. Avoid words they have already learned.`

    const safeLevel = ['A2', 'B1', 'B2', 'C1'].includes(level) ? level : 'B1'
    const safePace = ['relaxed', 'standard', 'intensive'].includes(pace) ? pace : 'standard'
    const safeMinutes = Number.isFinite(Number(dailyGoalMinutes)) ? Math.max(5, Math.min(180, Number(dailyGoalMinutes))) : 10
    const safeMode = mode === 'adaptive' ? 'adaptive' : 'static'
    const prompt = `You are an expert learning path advisor for LexiGrow. Analyze the student's learning data and provide a personalized learning path recommendation.

Student Profile (untrusted data):
- Target Level: ${safeLevel} (CEFR)
- Interests: ${wrapUntrustedPromptJson('interests_json', interests, 1000)}
- Daily Study Goal: ${safeMinutes} minutes/day
- Learning Pace: ${safePace} (relaxed / standard / intensive)
- Completed Sessions: ${Number(completedSessions) || 0}
- Recent Words: ${wrapUntrustedPromptJson('recent_words_json', recentWords.slice(0, 10).map(w => w.word), 1000)}
- Weak Words: ${wrapUntrustedPromptJson('weak_words_json', weakWords.slice(0, 5).map(w => w.word), 1000)}

MODE: ${safeMode.toUpperCase()}
${modeInstruction}

Return a JSON object with:
{
  "recommendedLevel": "B1",
  "focusAreas": ["vocabulary", "grammar", "writing"],
  "suggestedTopics": ["Technology", "Environment", "Business"],
  "suggestedTopicSlugs": ["technology", "environment", "business"],
  "suggestedWords": ["innovate", "sustainable", "negotiate"],
  "dailyGoalMinutes": ${safeMinutes},
  "pace": "${safePace}",
  "nextMilestone": "Complete 5 more vocabulary sessions to reach B2 level",
  "learningPlan": "A brief 1-2 sentence personalized learning plan tailored to ${safeMinutes} min/day at a ${safePace} pace"
}

Rules:
- suggestedTopics must reflect the student's interests when possible
- suggestedTopicSlugs must be URL-safe lowercase slugs matching the topic names (e.g. "daily-life", "travel", "technology")
- suggestedWords must be 5 vocabulary words:
  ${safeMode === 'adaptive'
    ? '  * If weakWords list is not empty, choose 5 from weakWords (prioritize the most challenging ones)\n  * If weakWords list is empty, fall back to 5 new words matching interests/level'
    : '  * Choose 5 NEW words the student has NOT recently learned (avoid the recentWords list)\n  * Match the student CEFR level and align with the suggested topics'}
- learningPlan must reference the student's pace and daily goal time realistically
- learningPlan MUST mention the mode: ${safeMode === 'adaptive' ? '"focus on reviewing your weakest words"' : '"discover new vocabulary on a fixed topic"'}

Return ONLY valid JSON, no markdown formatting.`

    const completion = await completeThroughRelay({
      route: 'learning_path',
      messages: [
        { role: 'system', content: `You are a learning path advisor AI. Return only valid JSON. ${UNTRUSTED_DATA_SYSTEM_RULE}` },
        { role: 'user', content: prompt }
      ],
      model: activeModel,
      responseFormat: { type: 'json_object' }
    })

    const responseText = completion.text
    let jsonStr = responseText.trim()
    const jsonMatch = responseText.match(/```(?:json)?\s*([\s\S]*?)```/)
    if (jsonMatch) {
      jsonStr = jsonMatch[1].trim()
    }

    const result = JSON.parse(jsonStr)
    const suggestedTopics = validateTopics(result.suggestedTopics, 3)
    const suggestedWords = Array.isArray(result.suggestedWords)
      ? [...new Set(result.suggestedWords.map((word) => String(word).trim().toLowerCase()).filter((word) => /^[a-z][a-z -]{2,49}$/.test(word)))].slice(0, 5)
      : []
    if (!suggestedTopics || suggestedWords.length !== 5) throw new Error('AI returned invalid learning-path recommendations')
    return { ...result, suggestedTopics, suggestedWords }
  } catch (error) {
    console.error('AI Learning Path Recommendation Error:', error.message)
    return {
      recommendedLevel: student.learningProfile?.targetLevel || 'B1',
      focusAreas: ['vocabulary'],
      suggestedTopics: student.learningProfile?.interests || ['general'],
      dailyGoalMinutes: 15,
      nextMilestone: 'Continue your learning journey!',
      learningPlan: 'Continue building vocabulary through daily quests and learning sessions.'
    }
  }
}

export default {
  generateAILearningSetRecommendation,
  generateAIDailyQuestWords,
  getPersonalizedLearningPath
}
/**
 * PracticeQuestionGenerator Service
 *
 * Generates dynamic, AI-powered vocabulary practice questions for learning sessions.
 * Each session gets a fresh, unique set of contextual practice questions (Multiple Choice & Fill-in-the-blank).
 *
 * Strategy:
 *  1. AI (via completeThroughRelay) — generates creative, context-rich sentences and questions tailored to level & theme.
 *  2. Robust Fallback — generates structured, varied questions with guaranteed blank masking if AI is offline.
 *  3. Caching on session — preserves questions during normal navigation, but allows ?bypassCache=1 to regenerate.
 */

import AILog from '../models/AILog.js'
import LearningSession from '../models/LearningSession.js'
import { completeThroughRelay } from './aiRelayClient.service.js'
import { UNTRUSTED_DATA_SYSTEM_RULE, validateQuizQuestion, wrapUntrustedPromptJson } from './aiGuardrails.service.js'

// =================== LOGGING HELPER ===================

async function logAICall({ model, action, duration, status, usage, cost, provider, requestId, errorMessage }) {
  const durationSec = duration !== undefined ? (duration / 1000).toFixed(2) : '0.00'
  if (status === 'failure' || errorMessage) {
    console.error(`[PracticeQuestions AI] ❌ [${action}] (${model || 'unknown'}) thất bại sau ${durationSec}s (${duration}ms) - Lỗi: ${errorMessage || 'Unknown error'}`)
  } else {
    console.log(`[PracticeQuestions AI] ⏱️ [${action}] (${model || 'unknown'}) hoàn thành trong ${durationSec}s (${duration}ms)`)
  }
  try {
    const promptTokens = usage?.prompt_tokens || usage?.promptTokens || 0
    const completionTokens = usage?.completion_tokens || usage?.completionTokens || 0
    const totalTokens = usage?.total_tokens || usage?.totalTokens || 0

    await AILog.create({
      model: model || 'unknown',
      provider: provider || '',
      requestId: requestId || '',
      tokensUsed: { promptTokens, completionTokens, totalTokens },
      usageAvailable: Boolean(usage),
      processingTimeMs: duration,
      costEstimate: cost?.cost ?? null,
      pricingSource: cost?.pricingSource || 'unknown',
      status,
      errorMessage: status === 'failure' ? errorMessage : undefined,
    })
  } catch (err) {
    console.warn('[PracticeQuestions] logAICall failed:', err.message)
  }
}

// =================== STRING & MASKING HELPERS ===================

/**
 * Ensures that a fill-in-the-blank sentence always contains the blank token '_______'
 * without leaving the answer exposed.
 */
function maskSentence(sentence, targetWord, correctAnswer) {
  if (!sentence || typeof sentence !== 'string') return ''

  // If already contains standard blank markers, normalize to '_______'
  if (/_{3,}/.test(sentence) || /\[blank\]/i.test(sentence)) {
    return sentence.replace(/_{3,}|\[blank\]/gi, '_______')
  }

  const wordsToTry = [correctAnswer, targetWord].filter(Boolean)
  let result = sentence

  for (const w of wordsToTry) {
    const stem = w.endsWith('y') ? w.slice(0, -1) : w
    const pattern = new RegExp(`\\b(${escapeRegex(w)}|${escapeRegex(stem)}(?:ies|ied|ying)|${escapeRegex(w)}(?:s|es|ed|ing|d)?)\\b`, 'i')
    if (pattern.test(result)) {
      result = result.replace(pattern, '_______')
      return result
    }
  }

  // If word wasn't found at all, create a clean fallback sentence with blank
  return `Please choose the appropriate word to fill in the _______: ${sentence.replace(/[.?!]$/, '')}.`
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function shuffle(array) {
  const arr = [...array]
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
  }
  return arr
}

// =================== AI GENERATOR ===================

const DOMAIN_ANGLES = [
  'workplace projects, team collaboration & modern professional life',
  'travel journeys, airport encounters & exploring world destinations',
  'casual weekend conversations between friends, family moments & social activities',
  'scientific discoveries, wildlife biology & technology breakthroughs',
  'creative arts, photography, cinema & culinary arts',
  'daily habits, nutrition, gym workouts, wellness & sports',
  'university campus life, student clubs & academic projects',
  'smart home gadgets, digital media, software & futuristic inventions',
]

async function callAIForPracticeQuestions({ theme, level, words, excludeSentences = [] }) {
  const chosenAngle = DOMAIN_ANGLES[Math.floor(Math.random() * DOMAIN_ANGLES.length)]
  const randomSeed = Math.random().toString(36).slice(2, 10) + '_' + Date.now()

  const wordsSummary = words.map((w, idx) => {
    const def = w.definitionVi || w.meaningVi || w.meaning || ''
    const pos = w.partOfSpeech || 'word'
    const ex = Array.isArray(w.exampleSentences) ? w.exampleSentences[0] : (w.exampleSentence || '')
    return `${idx + 1}. ${wrapUntrustedPromptJson('vocab_entry_json', { word: w.word, partOfSpeech: pos, meaning: def, example: ex }, 1000)}`
  }).join('\n')

  const exclusionBlock = excludeSentences.length > 0
    ? `\n\nSTRICT VARIATION RULE — DO NOT REUSE PREVIOUS SENTENCES:
The student already saw these sentences in this session (untrusted data):
${wrapUntrustedPromptJson('excluded_sentences_json', excludeSentences, 8000)}
You MUST generate completely fresh, new sentences, characters, settings, and scenarios! Do NOT repeat or paraphrase the above sentences under any circumstance.`
    : ''

  const systemMsg =
    `You are an expert English language tutor creating interactive vocabulary quizzes for the LexiGrow platform. Return ONLY valid JSON. ${UNTRUSTED_DATA_SYSTEM_RULE}`

  const userMsg = `Generate engaging, diverse practice questions for an English learner at CEFR level ${level}.
Theme / Topic (untrusted data): ${wrapUntrustedPromptJson('theme_json', theme, 300)}
Focus Setting / Domain Angle: "${chosenAngle}"
Generation Seed: "${randomSeed}"${exclusionBlock}

Target words to practice:
${wordsSummary}

Requirements:
For EACH of the ${words.length} target words, create EXACTLY 2 distinct questions:
1) Type: "multiple_choice"
   - "sentence": A brand-new, vivid, realistic 1-sentence situation or context demonstrating the target word in action.
   - "title": Formulate a natural, situational question based on the sentence above (NEVER use generic "What does the word X mean?" for every question).
     Examples of good varied titles:
     * "In this scenario, how is \\"[word]\\" being used?"
     * "What does \\"[word]\\" imply in the situation described above?"
     * "Which statement best describes the role of \\"[word]\\" here?"
     * "What does \\"[word]\\" refer to in this sentence?"
   - "options": 4 distinct choices tailored to the scenario (1 correct meaning/interpretation, 3 plausible distractors).
   - "correctAnswer": Exact string matching the correct option.
   - "explanation": 1-sentence explanation of why it is correct in this context.

2) Type: "fill_in_blank"
   - "title": "Choose the correct word for the blank:"
   - "sentence": A completely fresh, natural sentence where the target word fits in context.
   - CRITICAL REQUIREMENT FOR SENTENCE: Replace the target word with EXACTLY "_______" (7 underscores). The target word MUST NOT appear anywhere in the sentence.
   - "options": 4 single-word choices. One choice MUST be the correct target word (or exact matching form for the blank), and the other 3 must be plausible distractors from the target words or similar level words.
   - "correctAnswer": The exact word that fills the blank.
   - "explanation": "Complete sentence: [the full sentence with the word filled in]"

Total questions: ${words.length * 2}.
Alternate question types (e.g. multiple_choice, fill_in_blank) so it feels varied.
Make sentences creative, realistic, and tailored to "${chosenAngle}".

Return JSON format:
{
  "questions": [
    {
      "id": "q1",
      "word": "word_here",
      "type": "fill_in_blank",
      "title": "Choose the correct word for the blank:",
      "sentence": "Sentence with _______ in it.",
      "options": ["optA", "optB", "optC", "optD"],
      "correctAnswer": "optA",
      "explanation": "Complete sentence: ..."
    }
  ]
}
Return ONLY valid JSON, no markdown fences.`

  const startTime = Date.now()
  let usage = null

  try {
    const completion = await completeThroughRelay({
      route: 'practice_question_generation',
      temperature: 0.9,
      messages: [
        { role: 'system', content: systemMsg },
        { role: 'user', content: userMsg },
      ],
      responseFormat: { type: 'json_object' },
      timeoutMs: 25000,
    })

    usage = completion?.usage
    const cost = completion?.cost
    const provider = completion?.provider
    const requestId = completion?.requestId
    const model = completion?.model
    const rawText = completion?.text || ''
    const cleanJson = rawText
      .replace(/```(?:json)?\s*([\s\S]*?)```/g, '$1')
      .trim()

    const parsed = JSON.parse(cleanJson)
    const list = Array.isArray(parsed.questions) ? parsed.questions : []

    if (list.length === 0) {
      throw new Error('AI returned empty questions array')
    }

    // Sanitize and guarantee valid blanks
    const normalizeWordKey = (str) => (str || '').toLowerCase().replace(/[^a-z0-9]/g, '').trim()
    const validatedQuestions = list.map((q, idx) => {
      const type = q.type === 'multiple_choice' ? 'multiple_choice' : 'fill_in_blank'
      const qNorm = normalizeWordKey(q.word)
      const matched = words.find((tw) => normalizeWordKey(tw.word) === qNorm) || words[idx % words.length]
      const word = matched?.word || q.word || 'vocabulary'
      const wordId = matched?.wordId || (matched?._id ? String(matched._id) : undefined)
      let sentence = q.sentence || ''
      let options = Array.isArray(q.options) && q.options.length >= 2 ? q.options : []
      let correctAnswer = q.correctAnswer || options[0] || word

      if (type === 'fill_in_blank') {
        sentence = maskSentence(sentence, word, correctAnswer)
        if (!options.includes(correctAnswer)) {
          options = [correctAnswer, ...options].slice(0, 4)
        }
      }
      const question = validateQuizQuestion({
        question: type === 'fill_in_blank' ? sentence.replace(/_{3,}/g, word) : `${q.title || ''} ${sentence}`.trim(),
        options,
        correctAnswer,
        type,
      }, type === 'multiple_choice' ? word : '')
      if (!question || (type === 'fill_in_blank' && !sentence.includes('_______'))) throw new Error('AI returned an invalid practice question')

      // Ensure at least 4 options
      if (options.length < 4) {
        const fallbacks = words.map(w => w.word).filter(w => w !== correctAnswer)
        const extras = ['routine', 'commute', 'improve', 'challenge', 'progress', 'develop']
        const pool = [...new Set([...fallbacks, ...extras])]
        for (const item of pool) {
          if (options.length >= 4) break
          if (!options.includes(item)) options.push(item)
        }
      }

      return {
        id: q.id || `ai_q_${idx + 1}_${Date.now()}`,
        word,
        wordId,
        type,
        title: q.title || (type === 'multiple_choice' ? `What is the accurate meaning of "${word}"?` : 'Choose the correct word for the blank:'),
        sentence,
        translation: q.translation || '',
        options: shuffle(options.slice(0, 4)),
        correctAnswer,
        explanation: q.explanation || (type === 'fill_in_blank' ? `Complete sentence: "${sentence.replace('_______', correctAnswer)}"` : `${word}: ${correctAnswer}`)
      }
    })
    if (validatedQuestions.length !== words.length * 2) throw new Error('AI returned the wrong number of practice questions')
    for (const question of validatedQuestions) {
      if (question.type === 'fill_in_blank' && question.sentence.toLowerCase().includes(question.word.toLowerCase())) {
        throw new Error('AI practice blank exposed the target word')
      }
    }

    await logAICall({
      model,
      action: 'practice_question_generation',
      duration: Date.now() - startTime,
      status: 'success',
      usage,
      cost,
      provider,
      requestId,
    })

    return validatedQuestions
  } catch (err) {
    await logAICall({
      action: 'practice_question_generation',
      duration: Date.now() - startTime,
      status: 'failure',
      errorMessage: err.message,
    })
    console.warn('[PracticeQuestions] AI generation failed, using fallback:', err.message)
    return null
  }
}

// =================== FALLBACK GENERATOR ===================

/**
 * Builds high-quality practice questions rule-based when AI is unavailable.
 * Ensures variety, correct blanks, and valid distractors.
 */
function buildFallbackPracticeQuestions(theme, level, words) {
  const list = []

  words.forEach((w, idx) => {
    const word = typeof w === 'string' ? w : w.word
    const wordId = typeof w === 'string' ? `w_${idx}` : (w.wordId || (w._id ? String(w._id) : `w_${idx}`))
    const meaning = w.definitionVi || w.meaningVi || w.meaning || 'từ vựng'
    const otherWords = words.filter((_, i) => i !== idx).map(item => (typeof item === 'string' ? item : item.word))
    const otherMeanings = words.filter((_, i) => i !== idx).map(item => item.definitionVi || item.meaningVi || item.meaning).filter(Boolean)

    // 1. Multiple choice question
    const fallbackMeanings = [
      'khả năng lãnh đạo và quản lý',
      'trải nghiệm mới mẻ và độc đáo',
      'sự phát triển và mở rộng quy mô',
      'thói quen và hành động lặp lại'
    ]
    const mcOptions = shuffle([
      meaning,
      otherMeanings[0] || fallbackMeanings[0],
      otherMeanings[1] || fallbackMeanings[1],
      fallbackMeanings[2]
    ])

    const exampleSentence = Array.isArray(w.exampleSentences)
      ? (w.exampleSentences[0] || '')
      : (w.exampleSentence || '')

    const mcTitles = [
      `What does the word "${word}" mean in this context?`,
      `Which of the following is the best definition of "${word}"?`,
      `How is "${word}" most appropriately understood in this sentence?`,
      `What is the primary meaning of "${word}" in daily communication?`,
    ]
    const mcTitle = mcTitles[idx % mcTitles.length]

    list.push({
      id: `fb_mc_${word}_${idx}_${Date.now()}`,
      word,
      wordId,
      type: 'multiple_choice',
      title: mcTitle,
      sentence: exampleSentence ? `Example context: "${exampleSentence}"` : '',
      options: mcOptions,
      correctAnswer: meaning,
      explanation: `${word} (${w.partOfSpeech || 'word'}): ${meaning}`
    })

    // 2. Fill in the blank question
    // Pick the best example sentence or construct one that naturally fits
    let sentenceCandidate = exampleSentence
    if (!sentenceCandidate) {
      if (w.partOfSpeech === 'verb') {
        sentenceCandidate = `I often _______ every morning to get ready for my tasks.`
      } else if (w.partOfSpeech === 'adjective') {
        sentenceCandidate = `This approach is very _______ and saves us a lot of time.`
      } else {
        sentenceCandidate = `She needs a good _______ to stay organized throughout the day.`
      }
    }

    const masked = maskSentence(sentenceCandidate, word, word)
    const extraDistractors = ['improve', 'challenge', 'progress', 'routine', 'commute']
    const distractorPool = [...otherWords, ...extraDistractors].filter(d => d.toLowerCase() !== word.toLowerCase())

    const fibOptions = shuffle([
      word,
      distractorPool[0] || 'improve',
      distractorPool[1] || 'challenge',
      distractorPool[2] || 'progress'
    ])

    list.push({
      id: `fb_fib_${word}_${idx}_${Date.now()}`,
      word,
      wordId,
      type: 'fill_in_blank',
      title: 'Choose the correct word for the blank:',
      sentence: masked,
      translation: w.exampleTranslation || '',
      options: fibOptions,
      correctAnswer: word,
      explanation: `Complete sentence: "${exampleSentence || masked.replace('_______', word)}"`
    })
  })

  // Alternate the list: MC, FIB, MC, FIB...
  return list
}

// =================== MAIN SERVICE FUNCTION ===================

/**
 * Generates or retrieves practice questions for a session.
 *
 * @param {Object} session - Mongoose LearningSession document or object
 * @param {Object} options
 * @param {boolean} [options.bypassCache=false] - If true, force-regenerate with AI
 * @returns {Promise<{ questions: Array, source: 'ai'|'cache'|'fallback', generatedAt: Date }>}
 */
export async function generatePracticeQuestions(session, { bypassCache = false } = {}) {
  // If questions already cached in session and bypass not requested, return them
  if (!bypassCache && Array.isArray(session.practiceQuestions) && session.practiceQuestions.length > 0) {
    return {
      questions: session.practiceQuestions,
      source: 'cache',
      generatedAt: session.updatedAt || session.startedAt || new Date(),
    }
  }

  const rawWords = session.targetWords || []
  const words = rawWords.map((w, idx) => {
    if (typeof w === 'string') return { word: w, wordId: `w_${idx}` }
    return {
      word: w.word,
      wordId: w.wordId || (w._id ? String(w._id) : `w_${idx}`),
      partOfSpeech: w.partOfSpeech || 'word',
      definitionVi: w.definitionVi || w.meaningVi || w.meaning || '',
      exampleSentences: Array.isArray(w.exampleSentences) ? w.exampleSentences : (w.exampleSentence ? [w.exampleSentence] : []),
      exampleTranslation: w.exampleTranslation || '',
    }
  })

  const theme = session.theme || session.learningSetSlug || 'English Practice'
  const level = session.level || 'B1'

  const excludeSentences = Array.isArray(session.practiceQuestions)
    ? session.practiceQuestions.map(q => q.sentence).filter(Boolean)
    : []

  // 1. Try AI Generation
  const aiQuestions = await callAIForPracticeQuestions({ theme, level, words, excludeSentences })

  if (aiQuestions && aiQuestions.length >= 2) {
    // Atomically persist to session in MongoDB
    try {
      await LearningSession.updateOne(
        { _id: session._id },
        { $set: { practiceQuestions: aiQuestions } }
      )
    } catch (saveErr) {
      console.warn('[PracticeQuestions] Failed to cache questions on session:', saveErr.message)
    }

    return {
      questions: aiQuestions,
      source: 'ai',
      generatedAt: new Date(),
    }
  }

  // 2. Fallback Generation
  const fallbackQuestions = buildFallbackPracticeQuestions(theme, level, words)
  try {
    await LearningSession.updateOne(
      { _id: session._id },
      { $set: { practiceQuestions: fallbackQuestions } }
    )
  } catch (saveErr) {
    console.warn('[PracticeQuestions] Failed to cache fallback questions on session:', saveErr.message)
  }

  return {
    questions: fallbackQuestions,
    source: 'fallback',
    generatedAt: new Date(),
  }
}

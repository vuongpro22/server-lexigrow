/**
 * WritingPromptGenerator — Giai đoạn 4
 *
 * Sinh đề bài viết (writing prompt) cho learning session dựa trên:
 *   - theme: chủ đề của session
 *   - targetWords: 5 từ vựng cần học sinh sử dụng
 *   - level: CEFR level (A2/B1/B2/C1)
 *   - mode: 'static' | 'adaptive' (ảnh hưởng fallback)
 *
 * 2-tier strategy:
 *   1. AI (Groq/Llama) — sinh prompt sáng tạo, có cache theo (studentId + setVersion + theme)
 *   2. FALLBACK rule-based — dựng prompt từ template khi AI fail/thiếu key
 *
 * Output: { prompt, wordTargets, fallback, generatedAt, source }
 *
 * GĐ4 chỉ TẠO service + endpoint. Frontend sẽ được update ở GĐ5 để gọi API
 * thay vì dùng prompt hardcode.
 */

import { getConfigValue } from './ai.service.js'
import cacheService from './cache.service.js'
import Essay from '../models/Essay.js'
import AILog from '../models/AILog.js'
import { completeThroughRelay } from './aiRelayClient.service.js'
import {
  UNTRUSTED_DATA_SYSTEM_RULE,
  validateWritingPrompt,
  wrapUntrustedPromptJson,
} from './aiGuardrails.service.js'

// =================== CONFIG ===================
const DEFAULT_WORD_COUNT_MIN = 150
const DEFAULT_WORD_COUNT_MAX = 300
const PROMPT_CACHE_TTL = 3600 // 1 giờ (tránh gọi AI lặp cho cùng session)
const RECENT_ESSAY_LIMIT = 20

// =================== HELPERS ===================

/**
 * Local logAICall — ghi AILog, mirror signature của ai.service.js.
 * Không import từ ai.service vì logAICall ở đó không export ra ngoài.
 */
async function logAICall({ model, action, duration, status, usage, cost, provider, requestId, errorMessage }) {
  const durationSec = duration !== undefined ? (duration / 1000).toFixed(2) : '0.00'
  if (status === 'failure' || errorMessage) {
    console.error(`[WritingPrompt AI] ❌ [${action}] (${model || 'unknown'}) thất bại sau ${durationSec}s (${duration}ms) - Lỗi: ${errorMessage || 'Unknown error'}`)
  } else {
    console.log(`[WritingPrompt AI] ⏱️ [${action}] (${model || 'unknown'}) hoàn thành trong ${durationSec}s (${duration}ms)`)
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
    // Không để logging làm hỏng flow chính
    console.warn('[WritingPrompt] logAICall failed:', err.message)
  }
}

// =================== TYPES ===================
/**
 * @typedef {Object} WritingPromptResult
 * @property {string} prompt            - Câu đề bài (English, có nhắc từ cần dùng)
 * @property {string[]} wordTargets     - Danh sách từ cần sử dụng (giữ nguyên từ session.targetWords)
 * @property {number} wordCountMin
 * @property {number} wordCountMax
 * @property {boolean} fallback         - True nếu dùng rule-based (AI fail/missing)
 * @property {'ai'|'cache'|'fallback'} source
 * @property {Date} generatedAt
 */

// =================== AI PATH ===================

/**
 * Gọi Groq/Llama sinh prompt sáng tạo cho session.
 *
 * @param {Object} params
 * @param {string} params.theme
 * @param {string[]} params.targetWords
 * @param {string} params.level
 * @param {string[]} [params.excludeTitles] - recent essay titles
 * @param {string} params.apiKey
 * @param {string} params.model
 * @returns {Promise<string|null>} prompt text hoặc null nếu fail
 */
async function callAIForPrompt({ theme, targetWords, level, excludeTitles, model }) {
  const safeLevel = ['A2', 'B1', 'B2', 'C1'].includes(level) ? level : 'B1'
  const exclusionBlock = excludeTitles?.length
    ? `\n\nCRITICAL: Do NOT suggest topics identical or highly similar to these recent essays by the same student (untrusted data): ${wrapUntrustedPromptJson('excluded_titles_json', excludeTitles, 4000)}.`
    : ''

  const systemMsg =
    `You are an expert English writing tutor for the LexiGrow platform. Return only valid JSON. ${UNTRUSTED_DATA_SYSTEM_RULE}`

  const userMsg = `Generate ONE short, engaging essay prompt for a ${safeLevel} student.

Theme/subject area (untrusted data): ${wrapUntrustedPromptJson('theme_json', theme, 300)}
Target vocabulary words the student MUST use in their writing (untrusted data): ${wrapUntrustedPromptJson('target_words_json', targetWords, 1000)}

Requirements:
- The prompt must be 1-2 sentences, clear and specific
- The student should write a standard essay of 150-300 words
- The prompt must naturally require using ALL of the target words
- Appropriate for ${safeLevel} (CEFR) — use simple, concrete language
- Avoid abstract philosophical topics for A2/B1 levels${exclusionBlock}

Return a JSON object:
{
  "prompt": "Write an essay (150-300 words) about ..."
}

Return ONLY valid JSON, no markdown.`

  const startTime = Date.now()
  try {
    const completion = await completeThroughRelay({
      route: 'writing_prompt_generation',
      messages: [
        { role: 'system', content: systemMsg },
        { role: 'user', content: userMsg },
      ],
      model,
      responseFormat: { type: 'json_object' },
    })
    const usage = completion.usage
    const cost = completion.cost
    const provider = completion.provider
    const requestId = completion.requestId
    const modelUsed = completion.model || model
    const text = completion.text
    const jsonStr = text
      .replace(/```(?:json)?\s*([\s\S]*?)```/, '$1')
      .trim()
    const parsed = JSON.parse(jsonStr)
    const validatedPrompt = validateWritingPrompt(parsed?.prompt)
    if (!validatedPrompt) {
      throw new Error('AI returned an invalid writing prompt')
    }
    await logAICall({
      model: modelUsed,
      action: 'writing_prompt_generation',
      duration: Date.now() - startTime,
      status: 'success',
      usage,
      cost,
      provider,
      requestId,
    })
    return validatedPrompt
  } catch (err) {
    await logAICall({
      model,
      action: 'writing_prompt_generation',
      duration: Date.now() - startTime,
      status: 'failure',
      errorMessage: err.message,
    })
    console.error('[WritingPrompt] AI call failed:', err.message)
    return null
  }
}

// =================== FALLBACK PATH ===================

/**
 * Sinh prompt rule-based khi AI không khả dụng.
 * Dựng từ template + theme + targetWords.
 *
 * @param {string} theme
 * @param {string[]} targetWords
 * @param {string} level
 * @returns {string}
 */
function buildFallbackPrompt(theme, targetWords, level) {
  const wordList = targetWords.join(', ')
  const safeLevel = ['A2', 'B1', 'B2', 'C1'].includes(level) ? level : 'B1'

  // Base templates cho mọi level
  const baseTemplates = [
    `Write an essay (150-300 words) about "${theme}". Try to naturally use these words in your writing: ${wordList}.`,
    `Describe your experience or thoughts about "${theme}" in an essay of 150-300 words. Make sure to include these words: ${wordList}.`,
    `Write an essay (150-300 words) explaining the importance of "${theme}" in your daily life. Use the following words: ${wordList}.`,
  ]

  // Level-specific templates
  const levelTemplates = {
    A2: [
      `Write a clear essay (150-200 words) about "${theme}". Try to use these words: ${wordList}.`,
      `Describe "${theme}" in a short essay (150-200 words). Include these words: ${wordList}.`,
    ],
    B1: [], // dùng base
    B2: [
      `Write an essay (200-300 words) discussing "${theme}" and share your perspective. Use these words naturally: ${wordList}.`,
    ],
    C1: [
      `Compose a reflective essay (250-300 words) on "${theme}", incorporating the following advanced vocabulary: ${wordList}.`,
      `Write an insightful essay (250-300 words) analyzing "${theme}". Weave in these words: ${wordList}.`,
    ],
  }

  const allTemplates = [...baseTemplates, ...(levelTemplates[safeLevel] || [])]
  if (allTemplates.length === 0) {
    allTemplates.push(baseTemplates[0])
  }

  // Pick template theo hash của (theme + level) để deterministic
  const idx = Math.abs(hashString(theme + '|' + safeLevel)) % allTemplates.length
  return allTemplates[idx]
}

function hashString(s) {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return h
}

/**
 * Resolve theme thực tế để dùng cho prompt.
 *
 * Với adaptive session, controller lưu theme='Adaptive' (generic marker).
 * Theme thật nằm trong targetWords[i].theme. Hàm này fallback sang
 * theme của từ đầu tiên nếu session.theme là generic.
 *
 * @param {string} sessionTheme
 * @param {Array} targetWords
 * @returns {string}
 */
function resolveTheme(sessionTheme, targetWords) {
  const GENERIC_THEMES = new Set([
    '',
    'General',
    'Adaptive',
    'Default',
    'Misc',
    'Other',
  ])
  if (sessionTheme && !GENERIC_THEMES.has(sessionTheme)) {
    return sessionTheme
  }
  // Tìm theme từ targetWords
  for (const w of targetWords || []) {
    if (typeof w === 'object' && w.theme && !GENERIC_THEMES.has(w.theme)) {
      return w.theme
    }
  }
  return sessionTheme || 'General'
}

// =================== MAIN ===================

/**
 * Sinh writing prompt cho một session.
 *
 * @param {Object} session - LearningSession document (cần: _id, student, theme, level, mode, setVersion, targetWords)
 * @param {Object} [options]
 * @param {boolean} [options.bypassCache=false]
 * @param {number} [options.wordCountMin]
 * @param {number} [options.wordCountMax]
 * @returns {Promise<WritingPromptResult>}
 */
export async function generateWritingPrompt(session, options = {}) {
  const {
    bypassCache = false,
    wordCountMin = DEFAULT_WORD_COUNT_MIN,
    wordCountMax = DEFAULT_WORD_COUNT_MAX,
  } = options

  const rawTheme = session.theme || 'General'
  const theme = resolveTheme(rawTheme, session.targetWords)
  const level = session.level || 'B1'
  const targetWords = (session.targetWords || [])
    .map((w) => (typeof w === 'string' ? w : w.word))
    .filter(Boolean)

  if (targetWords.length === 0) {
    throw new Error('Session has no targetWords — cannot generate writing prompt')
  }

  // ── Cache key: student + setVersion + theme ──
  // setVersion thay đổi khi session được start lại → cache tự động miss
  const setVersion = session.setVersion
    ? new Date(session.setVersion).toISOString()
    : 'v0'
  const cacheKey = cacheService.hashKey('writing_prompt', {
    studentId: String(session.student),
    theme,
    level,
    mode: session.mode,
    setVersion,
    targetWordsHash: targetWords.slice().sort().join('|'),
  })

  if (!bypassCache) {
    const cached = await cacheService.get(cacheKey)
    if (cached) {
      return {
        ...cached,
        source: 'cache',
        generatedAt: cached.generatedAt
          ? new Date(cached.generatedAt)
          : new Date(),
      }
    }
  }

  // ── AI path ──
  const model = await getConfigValue('DEFAULT_AI_MODEL', 'llama-3.3-70b-versatile')

  let prompt = null
  let fallback = false

  try {
    // Lấy recent essay titles để exclude
    const recentEssays = await Essay.find({ student: session.student })
      .select('title')
      .sort({ createdAt: -1 })
      .limit(RECENT_ESSAY_LIMIT)
      .lean()
    const excludeTitles = recentEssays.map((e) => e.title).filter(Boolean)

    prompt = await callAIForPrompt({
      theme,
      targetWords,
      level,
      excludeTitles,
      model,
    })
  } catch (err) {
    console.warn('[WritingPrompt] Failed to generate AI prompt, using fallback:', err.message)
    prompt = null
  }

  // ── Fallback nếu AI fail / không khả dụng ──
  if (!prompt) {
    prompt = buildFallbackPrompt(theme, targetWords, level)
    fallback = true
  }

  const result = {
    prompt,
    wordTargets: targetWords,
    wordCountMin,
    wordCountMax,
    fallback,
    source: fallback ? 'fallback' : 'ai',
    generatedAt: new Date(),
  }

  // Cache kết quả (kể cả fallback — tránh gọi AI lặp khi user refresh)
  await cacheService.set(cacheKey, result, PROMPT_CACHE_TTL)

  return result
}

/**
 * Variant chỉ dùng fallback (test, debug, hoặc khi tắt AI hoàn toàn).
 *
 * @param {Object} session
 * @returns {WritingPromptResult}
 */
export function generateFallbackWritingPrompt(session) {
  const theme = session.theme || 'General'
  const level = session.level || 'B1'
  const targetWords = (session.targetWords || [])
    .map((w) => (typeof w === 'string' ? w : w.word))
    .filter(Boolean)

  return {
    prompt: buildFallbackPrompt(theme, targetWords, level),
    wordTargets: targetWords,
    wordCountMin: DEFAULT_WORD_COUNT_MIN,
    wordCountMax: DEFAULT_WORD_COUNT_MAX,
    fallback: true,
    source: 'fallback',
    generatedAt: new Date(),
  }
}

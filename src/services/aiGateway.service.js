import { createHash, randomUUID } from 'node:crypto'
import Config from '../models/Config.js'
import AIProviderAccount from '../models/AIProviderAccount.js'
import AIProviderModel from '../models/AIProviderModel.js'
import AIModelCombo from '../models/AIModelCombo.js'
import AILog from '../models/AILog.js'
import AIRequest, { AI_REQUEST_RETENTION_MS } from '../models/AIRequest.js'
import { decryptSecret } from '../utils/secretCrypto.js'
import { fetchSafeUrl } from '../utils/ssrfValidator.js'

const DEFAULT_MAX_ATTEMPTS = 3
const DEFAULT_GROQ_MODEL = 'llama-3.3-70b-versatile'
const AI_REQUEST_LEASE_MS = 180000
const AI_REQUEST_POSSIBLY_PROCESSED_RETENTION_MS = AI_REQUEST_RETENTION_MS

const PRICING_USD_PER_MILLION = {
  'groq:llama-3.3-70b-versatile': { input: 0.59, output: 0.79 },
  'groq:llama-3.1-8b-instant': { input: 0.05, output: 0.08 },
  'gemini:gemini-2.5-flash': { input: 0.30, output: 2.50 },
  'openai-compatible:gpt-4o-mini': { input: 0.15, output: 0.60 },
}

export function normalizeUsage(usage) {
  if (!usage) return { promptTokens: 0, completionTokens: 0, totalTokens: 0 }
  const promptTokens = Number(usage.promptTokens ?? usage.prompt_tokens ?? usage.promptTokenCount ?? 0)
  const completionTokens = Number(usage.completionTokens ?? usage.completion_tokens ?? usage.candidatesTokenCount ?? 0)
  const totalTokens = Number(usage.totalTokens ?? usage.total_tokens ?? usage.totalTokenCount ?? (promptTokens + completionTokens))
  return { promptTokens, completionTokens, totalTokens }
}

export function estimateCost({ provider, model, usage, inputCostPerMillionUsd, outputCostPerMillionUsd }) {
  const normalized = normalizeUsage(usage)
  const hasAccountPricing = Number.isFinite(inputCostPerMillionUsd) && inputCostPerMillionUsd >= 0
    && Number.isFinite(outputCostPerMillionUsd) && outputCostPerMillionUsd >= 0
  const pricing = hasAccountPricing
    ? { input: inputCostPerMillionUsd, output: outputCostPerMillionUsd }
    : PRICING_USD_PER_MILLION[`${provider}:${model}`]
  const pricingSource = hasAccountPricing ? 'account' : (pricing ? 'registry' : 'unknown')
  if (!pricing || normalized.totalTokens <= 0) return { cost: null, pricingSource }
  return {
    cost: (normalized.promptTokens * pricing.input + normalized.completionTokens * pricing.output) / 1e6,
    pricingSource,
  }
}

export class AIProviderError extends Error {
  constructor(message, { status = 502, code = 'AI_PROVIDER_ERROR', retryable = false, retryAfterMs = 0 } = {}) {
    super(message)
    this.name = 'AIProviderError'
    this.status = status
    this.code = code
    this.retryable = retryable
    this.retryAfterMs = retryAfterMs
  }
}

const number = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback

function retryAfterMs(error) {
  const value = error?.headers?.get?.('retry-after') || error?.response?.headers?.get?.('retry-after')
  if (!value) return 0
  const seconds = Number(value)
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
  const date = Date.parse(value)
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : 0
}

// Socket errors raised before a request reaches the provider. The provider
// cannot have processed (or billed) the request, so another provider is safe.
const CONNECT_FAILURE_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_CONNECT_TIMEOUT'])

function connectFailureCode(error) {
  let current = error
  for (let depth = 0; current && depth < 5; depth += 1) {
    const code = String(current.code || '').toUpperCase()
    if (CONNECT_FAILURE_CODES.has(code)) return code
    current = current.cause
  }
  return ''
}

export function classifyProviderError(error) {
  if (error instanceof AIProviderError) return error
  const status = Number(error?.status || error?.statusCode || error?.response?.status || 0)
  const code = String(error?.code || error?.error?.code || '').toUpperCase()
  const message = error?.message || 'AI provider request failed'
  const rateLimited = status === 429 || /RATE[_ -]?LIMIT|QUOTA|THROTTL|RESOURCE_EXHAUSTED/i.test(`${code} ${message}`)
  // Gemini answers an invalid key with HTTP 400 API_KEY_INVALID instead of 401.
  const authFailed = !rateLimited && (status === 401 || status === 403
    || (status === 400 && /API[_ ]?KEY[_ ]?(INVALID|NOT[_ ]VALID|EXPIRED)|API key not valid|API key expired/i.test(`${code} ${message}`)))
  const connectFailed = !rateLimited && !authFailed && Boolean(connectFailureCode(error))
  const timedOut = !connectFailed && (error?.name === 'AbortError' || error?.name === 'APIConnectionTimeoutError' || code === 'ETIMEDOUT' || /timeout|timed out/i.test(message))
  const network = connectFailed || timedOut || code === 'ECONNRESET' || /fetch failed|network|connection error/i.test(message)
  const modelNotFound = status === 404
  const retryable = rateLimited || network || status >= 500 || status === 408
  return new AIProviderError(message, {
    status: status || (connectFailed ? 503 : network ? 504 : 502),
    code: rateLimited ? 'RATE_LIMITED'
      : authFailed ? 'AUTH_FAILED'
        : connectFailed ? 'CONNECTION_FAILED'
          : timedOut ? 'TIMEOUT'
            : network ? 'NETWORK_ERROR'
              : modelNotFound ? 'MODEL_NOT_FOUND'
                : status >= 500 ? 'UPSTREAM_ERROR' : 'AI_REQUEST_ERROR',
    retryable,
    retryAfterMs: retryAfterMs(error),
  })
}

// Where a failed attempt sends the request next:
//  - 'key'      the key itself is bad or throttled: try the provider's next key
//  - 'provider' the provider is unreachable or lacks the model: try the next provider
//  - 'stop'     the request is invalid, or may already have been processed (AI-09)
export function failoverScope(error, mayHaveProcessed) {
  if (mayHaveProcessed) return 'stop'
  if (error.code === 'AUTH_FAILED' || error.code === 'RATE_LIMITED') return 'key'
  if (error.code === 'CONNECTION_FAILED' || error.code === 'MODEL_NOT_FOUND' || error.retryable) return 'provider'
  return 'stop'
}

function modelForAccount(account, requestedModel) {
  return account?.model || requestedModel || DEFAULT_GROQ_MODEL
}

function costRates(account) {
  const configured = Number.isFinite(account.inputCostPerMillionUsd) && account.inputCostPerMillionUsd >= 0
    && Number.isFinite(account.outputCostPerMillionUsd) && account.outputCostPerMillionUsd >= 0
  if (configured) return { input: account.inputCostPerMillionUsd, output: account.outputCostPerMillionUsd }
  return PRICING_USD_PER_MILLION[`${account.provider}:${modelForAccount(account)}`] || null
}

function maximumAttemptCost(account, { messages, prompt, maxTokens }) {
  const rates = costRates(account)
  if (!rates) return null
  const input = typeof prompt === 'string' ? prompt : JSON.stringify(messages || [])
  // UTF-8 bytes are a conservative upper bound for the input token estimate.
  const inputTokenUpperBound = Buffer.byteLength(input || '', 'utf8')
  return (inputTokenUpperBound * rates.input + maxTokens * rates.output) / 1e6
}

function requestConflict(code, message) {
  return new AIProviderError(message, { status: 409, code, retryable: false })
}

async function claimIdempotentRequest(requestId, fingerprint) {
  if (AIRequest.db.readyState !== 1) {
    throw new AIProviderError('AI idempotency storage is unavailable; request was not sent to a provider', {
      status: 503,
      code: 'AI_IDEMPOTENCY_STORE_UNAVAILABLE',
      retryable: false,
    })
  }
  const now = new Date()
  try {
    await AIRequest.create({
      requestId,
      fingerprint,
      state: 'processing',
      leaseUntil: new Date(now.getTime() + AI_REQUEST_LEASE_MS),
    })
    return { requestId, fingerprint }
  } catch (error) {
    if (error?.code !== 11000) throw error
  }

  const prior = await AIRequest.findOne({ requestId }).lean()
  if (!prior) throw requestConflict('AI_REQUEST_IN_PROGRESS', 'This AI request is already being claimed; retry with the same request ID.')
  if (prior.fingerprint !== fingerprint) {
    throw requestConflict('AI_REQUEST_KEY_REUSED', 'This idempotency key was already used for different AI input.')
  }
  if (prior.state === 'completed') return { replay: prior.result }
  if (prior.state === 'possibly_processed') {
    throw requestConflict('AI_REQUEST_POSSIBLY_PROCESSED', 'The provider may have processed this request. It was not sent again to avoid duplicate charges.')
  }
  if (prior.state === 'processing' && prior.leaseUntil > now) {
    throw requestConflict('AI_REQUEST_IN_PROGRESS', 'This AI request is still processing; retry with the same request ID.')
  }
  if (prior.state === 'processing') {
    await AIRequest.updateOne(
      { requestId, fingerprint, state: 'processing', leaseUntil: prior.leaseUntil },
      { $set: {
        state: 'possibly_processed',
        leaseUntil: null,
        expiresAt: new Date(now.getTime() + AI_REQUEST_POSSIBLY_PROCESSED_RETENTION_MS),
      } },
    )
    throw requestConflict('AI_REQUEST_POSSIBLY_PROCESSED', 'The request owner stopped responding. The provider may have processed it, so it was not resent.')
  }

  const reclaimed = await AIRequest.updateOne(
    { requestId, fingerprint, state: 'failed' },
    { $set: { state: 'processing', leaseUntil: new Date(now.getTime() + AI_REQUEST_LEASE_MS) }, $unset: { result: 1, expiresAt: 1 } },
  )
  if (!reclaimed.modifiedCount) throw requestConflict('AI_REQUEST_IN_PROGRESS', 'This AI request is already being retried.')
  return { requestId, fingerprint }
}

function accountSafe(account) {
  return account?.name || `${account?.provider || 'legacy'}:${account?.model || 'unknown'}`
}

// A provider gets up to this many keys per request before the gateway moves on
// to the next provider; the total bounds a request whose keys all fail fast.
const MAX_KEYS_PER_PROVIDER = 5
const MAX_TOTAL_PROVIDER_CALLS = 15

const isCoolingDown = (item, now = Date.now()) => Boolean(item?.cooldownUntil && new Date(item.cooldownUntil).getTime() > now)

function markKeyDecryptionFailed(account, keyId) {
  const now = new Date()
  const update = keyId
    ? AIProviderAccount.updateOne(
      { _id: account._id },
      { $set: { 'apiKeys.$[k].needsAttention': true, 'apiKeys.$[k].lastErrorCode': 'KEY_DECRYPTION_FAILED', 'apiKeys.$[k].lastErrorAt': now } },
      { arrayFilters: [{ 'k._id': keyId }] },
    )
    : AIProviderAccount.updateOne(
      { _id: account._id },
      { $set: { needsAttention: true, lastErrorCode: 'KEY_DECRYPTION_FAILED', lastErrorAt: now } },
    )
  return Promise.resolve(update).catch(() => {})
}

// Usable keys of a stored account, least recently used first so traffic spreads
// across keys. Accounts that predate multi-key support expose their single
// legacy key with keyId null; its health is tracked on the account itself.
async function resolveAccountKeys(account, now = Date.now()) {
  const stored = Array.isArray(account.apiKeys) ? account.apiKeys : []
  const entries = stored.length
    ? stored
      .map((key, index) => ({ key, index }))
      .filter(({ key }) => key.enabled !== false && !key.needsAttention && !isCoolingDown(key, now) && key.encryptedKey)
      .sort((a, b) => (new Date(a.key.lastUsedAt || 0) - new Date(b.key.lastUsedAt || 0)) || a.index - b.index)
      .map(({ key, index }) => ({ keyId: key._id, label: key.label || `#${index + 1}`, encryptedKey: key.encryptedKey, consecutiveFailures: key.consecutiveFailures || 0 }))
    : account.encryptedApiKey
      ? [{ keyId: null, label: '', encryptedKey: account.encryptedApiKey, consecutiveFailures: account.consecutiveFailures || 0 }]
      : []
  const keys = []
  for (const { encryptedKey, ...entry } of entries) {
    try {
      keys.push({ ...entry, apiKey: decryptSecret(encryptedKey) })
    } catch {
      console.warn(`Skipping an API key of AI provider account ${account.name || account._id}: invalid encrypted key`)
      await markKeyDecryptionFailed(account, entry.keyId)
    }
  }
  return keys
}

function withoutSecrets(account) {
  const rest = { ...account }
  delete rest.apiKeys
  delete rest.encryptedApiKey
  return rest
}

async function legacyAccount(providerPreference, requestedModel) {
  const keys = {
    groq: ['GROQ_API_KEY', 'GROQ_API_KEY'],
    gemini: ['GEMINI_API_KEY', 'GEMINI_API_KEY'],
    'openai-compatible': ['OPENAI_API_KEY', 'OPENAI_API_KEY'],
  }
  const provider = providerPreference || 'groq'
  const [configKey, envKey] = keys[provider] || keys.groq
  let config = null
  const isConfigDisconnected = Config.db && typeof Config.db.readyState === 'number' && Config.db.readyState !== 1
  if (!isConfigDisconnected) {
    const configQuery = Config.findOne({ key: configKey })
    config = typeof configQuery?.lean === 'function' ? await configQuery.lean() : await configQuery
  }
  let apiKey
  try {
    apiKey = config?.value
      ? (String(config.value).startsWith('v1.') || String(config.value).startsWith('v2.') ? decryptSecret(config.value) : config.value)
      : process.env[envKey]
  } catch {
    throw new AIProviderError('Stored AI API key cannot be decrypted. Restore AI_PROVIDER_ENCRYPTION_KEY or re-save the API key in Admin settings.', {
      status: 503, code: 'AI_SECRET_DECRYPTION_FAILED',
    })
  }
  if (!apiKey || String(apiKey).startsWith('gsk_dummy_prefix_000000000000') || String(apiKey).startsWith('your_')) return null
  return {
    _legacy: true,
    name: `legacy-${provider}`,
    provider,
    model: provider === 'groq'
      ? (requestedModel || process.env.DEFAULT_AI_MODEL || DEFAULT_GROQ_MODEL)
      : provider === 'gemini'
        ? (process.env.GEMINI_MODEL || 'gemini-2.5-flash')
        : (process.env.OPENAI_MODEL || 'gpt-4o-mini'),
    baseUrl: provider === 'openai-compatible' ? (process.env.OPENAI_BASE_URL || '') : '',
    keys: [{ keyId: null, label: '', apiKey, consecutiveFailures: 0 }],
    routes: [],
    priority: 1000,
  }
}

async function comboCandidates({ route, model, schema }) {
  if (AIModelCombo.db.readyState !== 1 || AIProviderModel.db.readyState !== 1) return []
  const counterKey = `r_${Buffer.from(String(route || 'default')).toString('hex')}`
  const defaultComboConfig = await Config.findOne({ key: 'DEFAULT_AI_COMBO' }).lean()
  const requestedComboId = typeof defaultComboConfig?.value === 'string'
    ? defaultComboConfig.value.match(/^[a-f\d]{24}$/i)?.[0]
    : null
  const increment = { $inc: { [`roundRobinCounters.${counterKey}`]: 1 } }
  let combo = requestedComboId
    ? await AIModelCombo.findOneAndUpdate(
      { _id: requestedComboId, routes: route, enabled: true },
      increment,
      { returnDocument: 'after' },
    ).lean()
    : null
  if (!combo) {
    combo = await AIModelCombo.findOneAndUpdate(
      { routes: route, active: true, enabled: true },
      increment,
      { returnDocument: 'after' },
    ).sort({ version: -1, updatedAt: -1 }).lean()
  }
  if (!combo) return []
  const fallbackModel = model
  const ordered = [...combo.candidates].filter((candidate) => candidate.enabled !== false).sort((a, b) => a.order - b.order)
  const resolved = []
  for (const candidate of ordered) {
    const providerModel = await AIProviderModel.findOne({ _id: candidate.model, enabled: true }).lean()
    if (!providerModel || (schema && !providerModel.capabilities?.structuredSchema && !providerModel.capabilities?.jsonMode)) continue
    const account = await AIProviderAccount.findOne({ _id: providerModel.account, enabled: true }).select('+encryptedApiKey +apiKeys.encryptedKey').lean()
    if (!account || account.needsAttention || isCoolingDown(account)) continue
    const keys = await resolveAccountKeys(account)
    if (!keys.length) continue
    resolved.push({
      ...withoutSecrets(account),
      provider: account.provider,
      model: providerModel.modelId,
      keys,
      inputCostPerMillionUsd: providerModel.inputCostPerMillionUsd ?? account.inputCostPerMillionUsd,
      outputCostPerMillionUsd: providerModel.outputCostPerMillionUsd ?? account.outputCostPerMillionUsd,
      comboId: combo._id,
    })
  }
  const pool = [...resolved]
  if (!pool.some((account) => account.provider === 'groq')) {
    const extraGroq = await storedGroqFallbacks(route, fallbackModel, new Set(resolved.map((item) => String(item._id))))
    if (!extraGroq.length) {
      const legacyGroq = await legacyAccount('groq', fallbackModel)
      if (legacyGroq) extraGroq.push(legacyGroq)
    }
    pool.push(...extraGroq)
  }
  return {
    pool,
    policy: { maxAttempts: combo.maxAttempts, timeoutMs: combo.timeoutMs, maxCostUsd: combo.maxCostUsd, comboId: combo._id },
  }
}

async function storedGroqFallbacks(route, model, excludedIds = new Set()) {
  if (AIProviderAccount.db.readyState !== 1) return []
  const query = { provider: 'groq', enabled: true, needsAttention: { $ne: true } }
  if (route) query.$or = [{ routes: route }, { routes: { $size: 0 } }]
  const stored = await AIProviderAccount.find(query).select('+encryptedApiKey +apiKeys.encryptedKey').sort({ priority: 1, _id: 1 }).lean()
  const pool = []
  for (const account of stored) {
    if (excludedIds.has(String(account._id)) || isCoolingDown(account)) continue
    const keys = await resolveAccountKeys(account)
    if (keys.length) pool.push({ ...withoutSecrets(account), keys, model: account.model || model })
  }
  return pool
}

async function candidates({ route, providerPreference, model, schema }) {
  const combo = await comboCandidates({ route, model, schema })
  if (combo && Array.isArray(combo.pool) && combo.pool.length) return combo
  const groqAccounts = await storedGroqFallbacks(route, model)
  const legacyGroq = await legacyAccount('groq', model)
  if (legacyGroq) groqAccounts.push(legacyGroq)
  if (providerPreference === 'gemini' || !groqAccounts.length) {
    const legacyGemini = await legacyAccount('gemini', model)
    if (legacyGemini) groqAccounts.unshift(legacyGemini)
  }
  return { pool: groqAccounts, policy: { maxAttempts: DEFAULT_MAX_ATTEMPTS, timeoutMs: 30000, maxCostUsd: null } }
}

// One shared import per SDK: concurrent first calls (e.g. testing several keys
// at once) must not each start their own module load.
let groqSdkPromise
let geminiSdkPromise
const loadGroqSdk = () => (groqSdkPromise ||= import('groq-sdk'))
const loadGeminiSdk = () => (geminiSdkPromise ||= import('@google/generative-ai'))

async function groqChat(account, { messages, model, responseFormat, temperature, maxTokens = 4096, timeoutMs = 30000, signal }) {
  const Groq = (await loadGroqSdk()).default
  // maxRetries: 0 — the gateway owns retries. The SDK default (2) would retry
  // the same throttled or expired key before the gateway could switch keys.
  const client = new Groq({ apiKey: account.apiKey, timeout: timeoutMs, maxRetries: 0 })
  const response = await client.chat.completions.create({
    messages,
    model: modelForAccount(account, model),
    ...(responseFormat ? { response_format: responseFormat } : {}),
    ...(temperature === undefined ? {} : { temperature }),
    max_tokens: maxTokens,
  }, { signal })
  const text = response.choices?.[0]?.message?.content
  if (typeof text !== 'string') throw new AIProviderError('Groq returned an empty response', { code: 'EMPTY_RESPONSE' })
  return { text, usage: response.usage || null, providerRequestId: response.id }
}

async function openAICompatibleChat(account, { messages, model, responseFormat, temperature, maxTokens = 4096, timeoutMs = 30000, requestId }, _attempt = 0) {
  const endpoint = (account.baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '') + '/chat/completions'
  let response
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    response = await fetchSafeUrl(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${account.apiKey}`,
        ...(requestId ? { 'Idempotency-Key': _attempt > 0 ? `${requestId}:r${_attempt}` : requestId, 'X-Request-Id': requestId } : {}),
      },
      body: JSON.stringify({
        messages,
        model: modelForAccount(account, model),
        stream: false,
        ...(responseFormat ? { response_format: responseFormat } : {}),
        ...(temperature === undefined ? {} : { temperature }),
        max_tokens: maxTokens,
      }),
      signal: controller.signal,
      redirect: 'error',
    })
  } catch (error) {
    if (controller.signal.aborted) {
      throw Object.assign(new AIProviderError('Provider request timed out; upstream processing may have completed', {
        status: 504, code: 'TIMEOUT', retryable: true,
      }), { mayHaveProcessed: true })
    }
    throw classifyProviderError(error)
  } finally {
    clearTimeout(timer)
  }
  if (!response.ok) {
    const errText = await response.text().catch(() => '')
    let errData = null
    try { errData = errText ? JSON.parse(errText) : null } catch { /* ignore non-JSON error body */ }
    const errCode = String(errData?.error?.code || '')
    const errMsg = String(errData?.error?.message || '')
    const failedGen = errData?.error?.failed_generation

    if (typeof failedGen === 'string' && failedGen.trim()) {
      let candidateJson = failedGen.trim()
      const fenceMatch = candidateJson.match(/```(?:json)?\s*([\s\S]*?)```/)
      if (fenceMatch) candidateJson = fenceMatch[1].trim()
      const braceStart = candidateJson.indexOf('{')
      const braceEnd = candidateJson.lastIndexOf('}')
      if (braceStart !== -1 && braceEnd > braceStart) {
        const sliced = candidateJson.slice(braceStart, braceEnd + 1)
        try {
          JSON.parse(sliced)
          return { text: sliced, usage: null, providerRequestId: null }
        } catch { /* fall through to retry */ }
      }
    }

    const isJsonValidateFailed = response.status === 400 && (
      errCode === 'json_validate_failed' ||
      /json_validate_failed|Failed to generate JSON|max_tokens|max_completion_tokens/i.test(`${errCode} ${errMsg}`)
    )
    const isRateLimited = response.status === 429 || /rate[_ -]?limit|tokens per minute|too many requests/i.test(`${errCode} ${errMsg}`)

    // A throttled key with a sibling key available fails fast so the gateway
    // switches keys instead of sleeping on the same key.
    const retrySameKeyOnRateLimit = isRateLimited && !account.hasAlternateKey
    if (_attempt < 2 && (isJsonValidateFailed || retrySameKeyOnRateLimit || response.status >= 500)) {
      if (isRateLimited || response.status >= 500) {
        const msgWaitMatch = errMsg.match(/try again in ([0-9.]+)s/i)
        const msgWaitMs = msgWaitMatch ? Math.ceil(Number(msgWaitMatch[1]) * 1000) : 0
        const waitMs = Math.min(Math.max(retryAfterMs(response) || msgWaitMs || 1800, 500), 4500)
        await new Promise((resolve) => setTimeout(resolve, waitMs))
      }
      return openAICompatibleChat(
        account,
        {
          messages,
          model,
          responseFormat: isJsonValidateFailed ? undefined : responseFormat,
          temperature,
          maxTokens: isJsonValidateFailed ? Math.min(maxTokens, 4096) : maxTokens,
          timeoutMs,
          requestId,
        },
        _attempt + 1,
      )
    }

    throw new AIProviderError(errMsg ? `OpenAI-compatible provider request failed: ${errMsg}` : 'OpenAI-compatible provider request failed', {
      status: response.status,
      code: isRateLimited ? 'RATE_LIMITED'
        : [401, 403].includes(response.status) ? 'AUTH_FAILED'
          : response.status === 404 ? 'MODEL_NOT_FOUND'
            : response.status >= 500 ? 'UPSTREAM_ERROR' : 'AI_REQUEST_ERROR',
      retryable: isRateLimited || isJsonValidateFailed || response.status >= 500,
      retryAfterMs: retryAfterMs(response),
    })
  }
  const rawText = await response.text()
  let data
  try {
    data = JSON.parse(rawText)
  } catch {
    const jsonMatch = rawText.match(/\{[\s\S]*"choices"[\s\S]*\}/)
    if (jsonMatch) {
      data = JSON.parse(jsonMatch[0])
    } else {
      throw new AIProviderError('OpenAI-compatible provider returned malformed JSON', { code: 'INVALID_JSON' })
    }
  }
  const text = data.choices?.[0]?.message?.content ?? data.choices?.[0]?.message?.reasoning ?? data.choices?.[0]?.message?.reasoning_content
  if (typeof text !== 'string') throw new AIProviderError('OpenAI-compatible provider returned an empty response', { code: 'EMPTY_RESPONSE' })
  return { text, usage: data.usage || null, providerRequestId: data.id }
}

async function geminiStructured(account, { prompt, messages, schema, model, responseFormat, maxTokens = 4096, temperature = 0.1, timeoutMs = 30000 }) {
  const { GoogleGenerativeAI } = await loadGeminiSdk()
  const ai = new GoogleGenerativeAI(account.apiKey)
  const contents = prompt || (messages || []).map((message) => `${message.role}: ${message.content}`).join('\n\n')
  const wantsJson = Boolean(schema || responseFormat?.type === 'json_object')
  const instance = ai.getGenerativeModel({
    model: modelForAccount(account, model),
    generationConfig: {
      ...(wantsJson ? { responseMimeType: 'application/json' } : {}),
      ...(schema ? { responseSchema: schema } : {}),
      temperature,
      maxOutputTokens: maxTokens,
    },
  })
  try {
    let timer
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new AIProviderError(
        'Gemini request timed out; upstream processing may have completed',
        { status: 504, code: 'TIMEOUT', retryable: true },
      ), { mayHaveProcessed: true })), timeoutMs)
    })
    let generated
    try {
      generated = await Promise.race([instance.generateContent(contents), timeout])
    } finally {
      clearTimeout(timer)
    }
    const text = generated.response.text()
    if (!text) throw new AIProviderError('Gemini returned an empty response', { code: 'EMPTY_RESPONSE' })
    return {
      text,
      usage: generated.response.usageMetadata ? {
        prompt_tokens: number(generated.response.usageMetadata.promptTokenCount),
        completion_tokens: number(generated.response.usageMetadata.candidatesTokenCount),
        total_tokens: number(generated.response.usageMetadata.totalTokenCount),
      } : null,
      providerRequestId: null,
    }
  } catch (error) {
    throw classifyProviderError(error)
  }
}

async function callAccount(account, options) {
  if (account.provider === 'groq') return groqChat(account, options)
  if (account.provider === 'gemini') return geminiStructured(account, options)
  if (account.provider === 'openai-compatible') return openAICompatibleChat(account, options)
  throw new AIProviderError(`Provider ${account.provider} does not support chat completion`, { status: 400, code: 'UNSUPPORTED_PROVIDER' })
}

// Sends a tiny prompt with one key. `encryptedKey` picks a key of a multi-key
// account; without it the legacy single key is used.
export async function testAIProviderAccount(accountDocument, { encryptedKey, prompt = 'Reply with the word OK.' } = {}) {
  const account = accountDocument.toObject ? accountDocument.toObject() : { ...accountDocument }
  account.apiKey = decryptSecret(encryptedKey || account.encryptedApiKey)
  const result = await callAccount(account, {
    prompt,
    messages: [{ role: 'user', content: prompt }],
    schema: undefined,
    responseFormat: undefined,
    maxTokens: 32,
    temperature: 0,
    timeoutMs: 10000,
  })
  return { provider: account.provider, model: modelForAccount(account), usage: result.usage }
}

function backoffMs(error, failures) {
  return error.retryAfterMs || (error.retryable ? Math.min(15 * 60 * 1000, 30000 * 2 ** Math.min(failures || 0, 4)) : 0)
}

async function recordAttemptSuccess(account, key) {
  const now = new Date()
  const $set = { lastUsedAt: now, consecutiveFailures: 0, lastErrorCode: '', needsAttention: false }
  if (!key.keyId) {
    await AIProviderAccount.updateOne({ _id: account._id }, { $set, $unset: { cooldownUntil: 1 } })
    return
  }
  Object.assign($set, {
    'apiKeys.$[k].lastUsedAt': now,
    'apiKeys.$[k].consecutiveFailures': 0,
    'apiKeys.$[k].lastErrorCode': '',
    'apiKeys.$[k].needsAttention': false,
    'apiKeys.$[k].cooldownUntil': null,
  })
  await AIProviderAccount.updateOne({ _id: account._id }, { $set, $unset: { cooldownUntil: 1 } }, { arrayFilters: [{ 'k._id': key.keyId }] })
}

// Key-scoped failures (expired/revoked key, per-key rate limit) are recorded on
// that key only. Everything else, and every failure of a legacy single-key
// account, is recorded on the account so the whole provider cools down.
async function recordAttemptFailure(account, key, error, scope) {
  const now = new Date()
  if (scope === 'key' && key.keyId) {
    const cooldown = error.code === 'RATE_LIMITED' ? backoffMs(error, key.consecutiveFailures) : 0
    await AIProviderAccount.updateOne(
      { _id: account._id },
      {
        $set: {
          'apiKeys.$[k].lastErrorCode': error.code,
          'apiKeys.$[k].lastErrorAt': now,
          ...(error.code === 'AUTH_FAILED' ? { 'apiKeys.$[k].needsAttention': true } : {}),
          ...(cooldown ? { 'apiKeys.$[k].cooldownUntil': new Date(now.getTime() + cooldown) } : {}),
        },
        $inc: { 'apiKeys.$[k].consecutiveFailures': 1 },
      },
      { arrayFilters: [{ 'k._id': key.keyId }] },
    )
    if (error.code === 'AUTH_FAILED') {
      // Flag the account for admins once none of its enabled keys still works.
      await AIProviderAccount.updateOne(
        { _id: account._id, apiKeys: { $not: { $elemMatch: { enabled: { $ne: false }, needsAttention: { $ne: true } } } } },
        { $set: { needsAttention: true, lastErrorCode: 'ALL_KEYS_FAILED', lastErrorAt: now } },
      )
    }
    return
  }
  const cooldown = backoffMs(error, account.consecutiveFailures)
  await AIProviderAccount.updateOne(
    { _id: account._id },
    { $set: { lastErrorCode: error.code, lastErrorAt: now, ...(error.code === 'AUTH_FAILED' ? { needsAttention: true } : {}), ...(cooldown ? { cooldownUntil: new Date(now.getTime() + cooldown) } : {}) }, $inc: { consecutiveFailures: 1 } },
  )
}

export async function completeAI({
  route,
  providerPreference,
  model,
  messages,
  prompt,
  schema,
  responseFormat,
  temperature,
  maxTokens = 4096,
  maxAttempts,
  timeoutMs,
  requestId: incomingRequestId,
}) {
  const requestId = typeof incomingRequestId === 'string' && incomingRequestId.trim() && incomingRequestId.length <= 128
    ? incomingRequestId
    : randomUUID()
  const hasStableRequestId = requestId === incomingRequestId
  const started = Date.now()
  const candidateSet = await candidates({ route, providerPreference, model, schema })
  const pool = candidateSet.pool
  const policy = candidateSet.policy || {}
  if (!pool.length) throw new AIProviderError('No AI provider is configured', { status: 503, code: 'AI_NOT_CONFIGURED' })
  const configuredAttempts = Number(policy.maxAttempts) || DEFAULT_MAX_ATTEMPTS
  const requestedAttempts = Number(maxAttempts) > 0 ? Number(maxAttempts) : configuredAttempts
  const attemptLimit = Math.max(1, Math.min(configuredAttempts, requestedAttempts, 10))
  const effectiveTimeoutMs = Math.max(1000, Math.min(Number(policy.timeoutMs) || 30000, Number(timeoutMs) || Number(policy.timeoutMs) || 30000))
  const costLimit = Number.isFinite(policy.maxCostUsd) && policy.maxCostUsd >= 0 ? policy.maxCostUsd : null
  let attemptPool = pool.slice(0, attemptLimit)
  const groqIndex = pool.findIndex((account) => account.provider === 'groq')
  if (groqIndex >= attemptLimit && attemptLimit > 1) {
    attemptPool = [...pool.slice(0, attemptLimit - 1), pool[groqIndex]]
  }
  const attempts = []
  let lastError
  let lastAccount
  let reservedCost = 0
  const deadline = started + effectiveTimeoutMs
  const effectiveMessages = Array.isArray(messages) && messages.length
    ? messages
    : (prompt ? [{ role: 'user', content: prompt }] : [])
  const effectivePrompt = prompt || (messages || []).map((m) => `${m.role}: ${m.content}`).join('\n\n')
  const effectiveResponseFormat = responseFormat || (schema ? { type: 'json_object' } : undefined)
  let idempotencyClaim = null
  if (hasStableRequestId) {
    const fingerprint = createHash('sha256').update(JSON.stringify({
      route, providerPreference, model, messages: effectiveMessages, prompt: effectivePrompt,
      schema, responseFormat: effectiveResponseFormat, temperature, maxTokens,
    })).digest('hex')
    idempotencyClaim = await claimIdempotentRequest(requestId, fingerprint)
    if (idempotencyClaim && Object.hasOwn(idempotencyClaim, 'replay')) return idempotencyClaim.replay
  }

  let providerCalls = 0
  providerLoop:
  for (const candidate of attemptPool) {
    const { keys: candidateKeys = [], ...accountFields } = candidate
    for (const key of candidateKeys.slice(0, MAX_KEYS_PER_PROVIDER)) {
      if (providerCalls >= MAX_TOTAL_PROVIDER_CALLS) break providerLoop
      providerCalls += 1
      const account = { ...accountFields, apiKey: key.apiKey, hasAlternateKey: candidateKeys.length > 1 }
      lastAccount = account
      let projectedAttemptCost = null
      const remainingMs = deadline - Date.now()
      if (remainingMs <= 0) {
        lastError = Object.assign(new AIProviderError('AI request exceeded its route timeout', { status: 504, code: 'TIMEOUT', retryable: false }), { mayHaveProcessed: false })
        break providerLoop
      }
      if (costLimit !== null) {
        const projected = maximumAttemptCost(account, { messages: effectiveMessages, prompt: effectivePrompt, maxTokens })
        projectedAttemptCost = projected
        if (projected === null || reservedCost + projected > costLimit) {
          lastError = new AIProviderError(projected === null
            ? 'Cannot enforce route cost limit because provider pricing is unknown'
            : 'Route cost limit reached before another provider attempt', { status: 429, code: 'AI_COST_LIMIT', retryable: false })
          attempts.push({ account: accountSafe(account), key: key.label || undefined, status: 'skipped', code: lastError.code, mayHaveProcessed: false })
          break providerLoop
        }
        // Reserve the maximum configured input/output spend before sending data.
        // This also accounts conservatively for timed-out attempts that may be billed.
        reservedCost += projected
      }
      const attemptStarted = Date.now()
      let upstreamReturned = false
      try {
        const result = await callAccount(account, {
          messages: effectiveMessages,
          prompt: effectivePrompt,
          schema,
          model,
          responseFormat: effectiveResponseFormat,
          temperature,
          maxTokens,
          timeoutMs: Math.max(1, deadline - Date.now()),
          requestId,
        })
        upstreamReturned = true
        if (!account._legacy) await recordAttemptSuccess(account, key)
        attempts.push({ account: accountSafe(account), key: key.label || undefined, status: 'success', durationMs: Date.now() - attemptStarted, cost: result.usage ? estimateCost({ provider: account.provider, model: modelForAccount(account, model), usage: result.usage, inputCostPerMillionUsd: account.inputCostPerMillionUsd, outputCostPerMillionUsd: account.outputCostPerMillionUsd }).cost : null })
        const attemptSec = ((Date.now() - attemptStarted) / 1000).toFixed(2)
        console.log(`[AI Gateway] ⏱️ [${route || 'ai'}] ${account.provider}:${modelForAccount(account, model)} phản hồi thành công trong ${attemptSec}s (${Date.now() - attemptStarted}ms)`)
        const anyPriorMayHaveProcessed = attempts.slice(0, -1).some(a => a.mayHaveProcessed)
        const successResult = {
          text: result.text,
          usage: normalizeUsage(result.usage),
          usageAvailable: result.usage !== null && result.usage !== undefined,
          cost: estimateCost({
            provider: account.provider,
            model: modelForAccount(account, model),
            usage: result.usage,
            inputCostPerMillionUsd: account.inputCostPerMillionUsd,
            outputCostPerMillionUsd: account.outputCostPerMillionUsd,
          }),
          requestId,
          provider: account.provider,
          account: accountSafe(account),
          model: modelForAccount(account, model),
          durationMs: Date.now() - started,
          attempts,
          providerRequestId: result.providerRequestId || null,
          possibly_processed: anyPriorMayHaveProcessed,
        }
        if (idempotencyClaim) {
          try {
            await AIRequest.updateOne(
              { requestId, fingerprint: idempotencyClaim.fingerprint, state: 'processing' },
              { $set: {
                state: 'completed',
                result: successResult,
                leaseUntil: null,
                expiresAt: new Date(Date.now() + AI_REQUEST_RETENTION_MS),
              } },
            )
          } catch (error) {
            await AIRequest.updateOne(
              { requestId, fingerprint: idempotencyClaim.fingerprint, state: 'processing' },
              { $set: {
                state: 'possibly_processed',
                leaseUntil: null,
                expiresAt: new Date(Date.now() + AI_REQUEST_POSSIBLY_PROCESSED_RETENTION_MS),
              } },
            ).catch(() => {})
            throw Object.assign(new AIProviderError('Provider completed the request but its idempotency record could not be saved', {
              status: 503, code: 'AI_REQUEST_RECORD_FAILED', retryable: false,
            }), { mayHaveProcessed: true, cause: error })
          }
        }
        const totalDurationSec = ((Date.now() - started) / 1000).toFixed(2)
        console.log(`[AI Gateway] ✅ [${route || 'ai'}] Hoàn tất yêu cầu AI trong ${totalDurationSec}s (${Date.now() - started}ms)`)
        return successResult
      } catch (rawError) {
        const error = classifyProviderError(rawError)
        lastError = error
        const mayHaveProcessed = Boolean(
          upstreamReturned || rawError.mayHaveProcessed || error.mayHaveProcessed ||
          (error.code !== 'CONNECTION_FAILED' && (error.code === 'TIMEOUT' || error.code === 'NETWORK_ERROR' || error.status >= 500)),
        )
        const scope = failoverScope(error, mayHaveProcessed)
        attempts.push({ account: accountSafe(account), key: key.label || undefined, status: 'failure', code: error.code, scope, statusCode: error.status, durationMs: Date.now() - attemptStarted, mayHaveProcessed, possibleChargeUsd: mayHaveProcessed ? projectedAttemptCost : null })
        const attemptSec = ((Date.now() - attemptStarted) / 1000).toFixed(2)
        console.warn(`[AI Gateway] ⚠️ [${route || 'ai'}] ${account?.provider || 'unknown'}:${modelForAccount(account, model)} thất bại sau ${attemptSec}s (${Date.now() - attemptStarted}ms): ${rawError?.message}`)
        // An attempt the provider never processed cannot be billed: release its reservation.
        if (!mayHaveProcessed && projectedAttemptCost) reservedCost = Math.max(0, reservedCost - projectedAttemptCost)
        if (!account._legacy) await recordAttemptFailure(account, key, error, scope)
        if (scope === 'key') continue
        if (scope === 'provider') continue providerLoop
        // AI-09: never fail over once the request may have been processed upstream (double billing).
        break providerLoop
      }
    }
  }
  if (idempotencyClaim) {
    const possiblyProcessed = attempts.some((attempt) => attempt.mayHaveProcessed)
    await AIRequest.updateOne(
      { requestId, fingerprint: idempotencyClaim.fingerprint, state: 'processing' },
      { $set: {
        state: possiblyProcessed ? 'possibly_processed' : 'failed',
        leaseUntil: null,
        expiresAt: new Date(Date.now() + (possiblyProcessed
          ? AI_REQUEST_POSSIBLY_PROCESSED_RETENTION_MS
          : AI_REQUEST_RETENTION_MS)),
      } },
    ).catch(() => {})
  }
  if (!lastError) lastError = new AIProviderError('No usable AI provider key is configured', { status: 503, code: 'AI_NOT_CONFIGURED' })
  lastError.attempts = attempts
  lastError.requestId = requestId
  const failedAccount = lastAccount
  if (failedAccount) {
    lastError.provider = failedAccount.provider
    lastError.account = accountSafe(failedAccount)
    lastError.model = modelForAccount(failedAccount, model)
  }
  lastError.statusCode = lastError.status
  const totalDurationSec = ((Date.now() - started) / 1000).toFixed(2)
  console.error(`[AI Gateway] ❌ [${route || 'ai'}] Toàn bộ lượt thử thất bại sau ${totalDurationSec}s (${Date.now() - started}ms): ${lastError?.message}`)
  throw lastError
}

export const aiMeta = ({ result, source = 'ai', isFallback = false }) => ({
  source,
  isFallback,
  provider: result?.provider || null,
  account: result?.account || null,
  model: result?.model || null,
  latencyMs: result?.durationMs || 0,
  requestId: result?.requestId || null,
  attempts: result?.attempts || [],
})

export async function logAICompletion({ route, action = route, result, error, durationMs = 0 }) {
  const actualDurationMs = result?.durationMs || durationMs
  const durationSec = (actualDurationMs / 1000).toFixed(2)
  const actualModel = result?.model || error?.model || 'unknown'
  const actualProvider = result?.provider || error?.provider || ''
  if (error) {
    console.error(`[AI Completion] ❌ [${route || action}] (${actualProvider}:${actualModel}) thất bại sau ${durationSec}s (${actualDurationMs}ms)`)
  } else {
    console.log(`[AI Completion] ⏱️ [${route || action}] (${actualProvider}:${actualModel}) hoàn tất trong ${durationSec}s (${actualDurationMs}ms)`)
  }
  const isLogDisconnected = AILog.db && typeof AILog.db.readyState === 'number' && AILog.db.readyState !== 1
  if (isLogDisconnected) return
  const usage = normalizeUsage(result?.usage)
  const cost = result?.cost || estimateCost({ provider: result?.provider || error?.provider, model: result?.model || error?.model, usage })
  try {
    await AILog.create({
      route,
      action,
      model: result?.model || error?.model || 'unknown',
      provider: result?.provider || error?.provider || '',
      providerAccount: result?.account || error?.account || '',
      requestId: result?.requestId || error?.requestId || '',
      providerRequestId: result?.providerRequestId || '',
      attempts: result?.attempts || error?.attempts || [],
      statusCode: error?.status || error?.statusCode || null,
      failoverReason: (result?.attempts || error?.attempts || []).filter((attempt) => attempt.status === 'failure').map((attempt) => attempt.code).join(','),
      tokensUsed: usage,
      usageAvailable: Boolean(result?.usageAvailable),
      processingTimeMs: result?.durationMs || durationMs,
      costEstimate: cost.cost,
      pricingSource: cost.pricingSource,
      status: error ? 'failure' : 'success',
      errorMessage: error ? String(error.code || (error.status === 504 ? 'TIMEOUT' : 'AI_PROVIDER_ERROR')).slice(0, 120) : undefined,
      source: 'ai',
      isFallback: false,
    })
  } catch (loggingError) {
    console.error('Failed to save AI completion log:', loggingError.message)
  }
}

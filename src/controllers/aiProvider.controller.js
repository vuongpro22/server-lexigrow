import AIProviderAccount, { MAX_API_KEYS_PER_ACCOUNT } from '../models/AIProviderAccount.js'
import AIProviderModel from '../models/AIProviderModel.js'
import AIModelCombo from '../models/AIModelCombo.js'
import Config from '../models/Config.js'
import asyncHandler from '../utils/asyncHandler.js'
import ErrorResponse from '../utils/ErrorResponse.js'
import { decryptSecret, encryptSecret, maskSecret } from '../utils/secretCrypto.js'
import { testAIProviderAccount } from '../services/aiGateway.service.js'
import { AI_ROUTES } from '../constants/aiRoutes.js'
import { fetchSafeUrl, validateSafeUrl } from '../utils/ssrfValidator.js'
import { logAction } from '../utils/auditLogger.js'

const PROVIDERS = new Set(['groq', 'gemini', 'openai-compatible'])
const clean = (value, max = 300) => typeof value === 'string' ? value.trim().slice(0, max) : ''
const validatedRoutes = (routes) => {
  if (!Array.isArray(routes)) return []
  const values = [...new Set(routes.map((route) => clean(route, 100)).filter(Boolean))]
  const invalid = values.find((route) => !AI_ROUTES.has(route))
  if (invalid) throw new ErrorResponse(`Unsupported AI route: ${invalid}`, 400)
  return values
}
// Only the declared capability flags exist on AIProviderModel. Rejecting unknown
// keys stops an admin payload from writing arbitrary fields onto the document.
const CAPABILITY_FLAGS = ['jsonMode', 'structuredSchema', 'text', 'vision']
const parseCapabilities = (input) => {
  if (input === undefined || input === null) return undefined
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new ErrorResponse('Capabilities must be an object', 400)
  }
  const unknown = Object.keys(input).find((key) => !CAPABILITY_FLAGS.includes(key))
  if (unknown) throw new ErrorResponse(`Unsupported capability: ${unknown}`, 400)
  const parsed = {}
  for (const key of CAPABILITY_FLAGS) {
    if (input[key] !== undefined) parsed[key] = Boolean(input[key])
  }
  return parsed
}
const parsePricing = (input, output) => {
  const hasInput = input !== undefined && input !== null && input !== ''
  const hasOutput = output !== undefined && output !== null && output !== ''
  if (hasInput !== hasOutput) throw new ErrorResponse('Set both input and output token prices, or leave both empty', 400)
  if (!hasInput) return { inputCostPerMillionUsd: null, outputCostPerMillionUsd: null }
  const inputCostPerMillionUsd = Number(input)
  const outputCostPerMillionUsd = Number(output)
  if (![inputCostPerMillionUsd, outputCostPerMillionUsd].every((value) => Number.isFinite(value) && value >= 0)) {
    throw new ErrorResponse('Token prices must be non-negative numbers', 400)
  }
  return { inputCostPerMillionUsd, outputCostPerMillionUsd }
}
const LEGACY_KEY_ID = 'legacy'
const KEY_HEALTH_FIELDS = ['cooldownUntil', 'needsAttention', 'consecutiveFailures', 'lastUsedAt', 'lastErrorCode', 'lastErrorAt']

const publicKey = (key) => ({
  _id: key._id,
  label: key.label || '',
  maskedKey: key.maskedKey || '••••••••',
  enabled: key.enabled !== false,
  cooldownUntil: key.cooldownUntil || null,
  needsAttention: Boolean(key.needsAttention),
  consecutiveFailures: key.consecutiveFailures || 0,
  lastUsedAt: key.lastUsedAt || null,
  lastErrorCode: key.lastErrorCode || '',
  lastErrorAt: key.lastErrorAt || null,
})

// Accounts created before multi-key support hold one key in encryptedApiKey and
// track its health on the account. Show it as a single key with a stable id.
const publicKeys = (account) => {
  if (Array.isArray(account.apiKeys) && account.apiKeys.length) return account.apiKeys.map(publicKey)
  if (!account.encryptedApiKey) return []
  return [publicKey({ _id: LEGACY_KEY_ID, label: 'Key 1', maskedKey: account.maskedKey, enabled: true, ...Object.fromEntries(KEY_HEALTH_FIELDS.map((field) => [field, account[field]])) })]
}

const maskStoredKey = (encryptedKey) => {
  try {
    return maskSecret(decryptSecret(encryptedKey))
  } catch {
    return '••••••••'
  }
}

const cleanKeyLabel = (value) => clean(value, 60)

// Moves a legacy single key into apiKeys so it can be managed like any other
// key. Its health moves with it; the account keeps only provider-wide health.
const ensureKeyList = (account) => {
  if (account.apiKeys.length || !account.encryptedApiKey) return
  account.apiKeys.push({
    label: 'Key 1',
    encryptedKey: account.encryptedApiKey,
    maskedKey: maskStoredKey(account.encryptedApiKey),
    enabled: true,
    needsAttention: Boolean(account.needsAttention),
    cooldownUntil: account.cooldownUntil || null,
    consecutiveFailures: account.consecutiveFailures || 0,
    lastUsedAt: account.lastUsedAt || null,
    lastErrorCode: account.lastErrorCode || '',
    lastErrorAt: account.lastErrorAt || null,
  })
  account.encryptedApiKey = undefined
  account.needsAttention = false
  account.cooldownUntil = null
  account.consecutiveFailures = 0
  account.lastErrorCode = ''
}

const findKey = (account, keyId) => {
  if (keyId === LEGACY_KEY_ID) return account.apiKeys[0] || null
  return account.apiKeys.find((key) => String(key._id) === String(keyId)) || null
}

// The account is flagged only when none of its enabled keys can still be used.
const syncAccountAttention = (account) => {
  const usable = account.apiKeys.some((key) => key.enabled !== false && !key.needsAttention)
  if (usable) {
    if (['ALL_KEYS_FAILED', 'NO_USABLE_KEY'].includes(account.lastErrorCode)) account.lastErrorCode = ''
    account.needsAttention = false
    return
  }
  account.needsAttention = true
  account.lastErrorCode = account.apiKeys.some((key) => key.enabled !== false) ? 'ALL_KEYS_FAILED' : 'NO_USABLE_KEY'
  account.lastErrorAt = new Date()
}

const resetKeyHealth = (key) => {
  key.needsAttention = false
  key.cooldownUntil = null
  key.consecutiveFailures = 0
  key.lastErrorCode = ''
  key.lastErrorAt = null
}

const decryptedKeys = (account) => account.apiKeys.flatMap((key) => {
  try {
    return [decryptSecret(key.encryptedKey)]
  } catch {
    return []
  }
})

// Accepts `apiKey` (one key) and/or `apiKeys` (strings or { apiKey, label }).
const parseNewKeys = (apiKey, apiKeys) => {
  const items = []
  if (typeof apiKey === 'string' && clean(apiKey, 1000)) items.push({ key: clean(apiKey, 1000), label: '' })
  if (apiKeys !== undefined) {
    if (!Array.isArray(apiKeys)) throw new ErrorResponse('API keys must be a list', 400)
    for (const item of apiKeys) {
      const key = clean(typeof item === 'string' ? item : item?.apiKey, 1000)
      if (key) items.push({ key, label: cleanKeyLabel(typeof item === 'string' ? '' : item?.label) })
    }
  }
  const unique = [...new Map(items.map((item) => [item.key, item])).values()]
  if (unique.length > MAX_API_KEYS_PER_ACCOUNT) {
    throw new ErrorResponse(`An AI provider account can hold at most ${MAX_API_KEYS_PER_ACCOUNT} API keys`, 400)
  }
  return unique
}

const isAuthFailure = (error) => error?.code === 'AUTH_FAILED' || [401, 403].includes(Number(error?.status || error?.statusCode))

const publicAccount = (account) => ({
  _id: account._id,
  name: account.name,
  provider: account.provider,
  model: account.model,
  inputCostPerMillionUsd: account.inputCostPerMillionUsd ?? null,
  outputCostPerMillionUsd: account.outputCostPerMillionUsd ?? null,
  baseUrl: account.baseUrl || '',
  enabled: account.enabled,
  priority: account.priority,
  routes: account.routes || [],
  isConfigured: publicKeys(account).length > 0,
  maskedKey: publicKeys(account)[0]?.maskedKey || '••••••••',
  apiKeys: publicKeys(account),
  keyCount: publicKeys(account).length,
  cooldownUntil: account.cooldownUntil,
  needsAttention: Boolean(account.needsAttention),
  consecutiveFailures: account.consecutiveFailures,
  lastUsedAt: account.lastUsedAt,
  lastErrorCode: account.lastErrorCode,
})

const publicModel = (model) => ({
  _id: model._id,
  account: model.account,
  modelId: model.modelId,
  displayName: model.displayName,
  capabilities: model.capabilities,
  inputCostPerMillionUsd: model.inputCostPerMillionUsd,
  outputCostPerMillionUsd: model.outputCostPerMillionUsd,
  enabled: model.enabled,
})

export const listAIProviders = asyncHandler(async (req, res) => {
  const accounts = await AIProviderAccount.find().select('+encryptedApiKey').sort({ priority: 1, name: 1 }).lean()
  res.json({ success: true, data: accounts.map((account) => publicAccount({
    ...account,
    maskedKey: account.encryptedApiKey ? maskStoredKey(account.encryptedApiKey) : undefined,
  })) })
})

export const createAIProvider = asyncHandler(async (req, res) => {
  const { name, provider, model, models, apiKey, apiKeys, baseUrl, priority, routes, enabled, inputCostPerMillionUsd, outputCostPerMillionUsd } = req.body || {}
  const newKeys = parseNewKeys(apiKey, apiKeys)
  const selectedModels = Array.isArray(models)
    ? models.slice(0, 100).map((item) => ({ modelId: clean(item?.modelId, 160), displayName: clean(item?.displayName, 160) })).filter((item) => item.modelId)
    : []
  const primaryModel = clean(model, 160) || selectedModels[0]?.modelId
  if (!clean(name, 100) || !PROVIDERS.has(provider) || !primaryModel || !newKeys.length) {
    throw new ErrorResponse('Provider name, type, at least one model and API key are required', 400)
  }
  if (!selectedModels.some((item) => item.modelId === primaryModel)) selectedModels.unshift({ modelId: primaryModel, displayName: primaryModel })
  const uniqueModels = [...new Map(selectedModels.map((item) => [item.modelId, item])).values()]
  const pricing = parsePricing(inputCostPerMillionUsd, outputCostPerMillionUsd)
  if (baseUrl) {
    await validateSafeUrl(baseUrl)
  }
  const account = await AIProviderAccount.create({
    name: clean(name, 100),
    provider,
    model: primaryModel,
    ...pricing,
    baseUrl: clean(baseUrl, 300),
    apiKeys: newKeys.map((item, index) => ({
      label: item.label || `Key ${index + 1}`,
      encryptedKey: encryptSecret(item.key),
      maskedKey: maskSecret(item.key),
    })),
    priority: Number.isInteger(priority) ? Math.min(1000, Math.max(0, priority)) : 100,
    routes: validatedRoutes(routes).slice(0, 30),
    enabled: enabled !== false,
  })
  let createdModels
  try {
    createdModels = await AIProviderModel.insertMany(uniqueModels.map((item) => ({
      account: account._id,
      modelId: item.modelId,
      displayName: item.displayName || item.modelId,
      capabilities: { jsonMode: true, structuredSchema: provider === 'gemini', text: true, vision: false },
      ...pricing,
    })))
  } catch (error) {
    await AIProviderAccount.deleteOne({ _id: account._id })
    throw error
  }
  await logAction(req.user?._id, 'ADMIN_CREATE_AI_PROVIDER', 'AIProviderAccount', account._id, { name: account.name, provider: account.provider })
  res.status(201).json({ success: true, data: {
    ...publicAccount(account.toObject()),
    defaultModel: publicModel(createdModels.find((item) => item.modelId === primaryModel).toObject()),
    models: createdModels.map((item) => publicModel(item.toObject())),
  } })
})

export const discoverAIProviderModels = asyncHandler(async (req, res) => {
  const { provider, baseUrl, apiKey } = req.body || {}
  if (!PROVIDERS.has(provider) || !clean(apiKey, 1000)) {
    throw new ErrorResponse('Provider type and API key are required', 400)
  }

  const defaultBaseUrl = provider === 'groq'
    ? 'https://api.groq.com/openai/v1'
    : provider === 'gemini'
      ? 'https://generativelanguage.googleapis.com/v1beta'
      : ''
  const configuredBaseUrl = clean(baseUrl, 300) || defaultBaseUrl
  if (!configuredBaseUrl) throw new ErrorResponse('Base URL is required for this provider', 400)

  await validateSafeUrl(configuredBaseUrl)

  const rootUrl = configuredBaseUrl.replace(/\/+$/, '').replace(/\/(?:chat\/completions|models)$/i, '')
  const endpoint = `${rootUrl}/models`
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 12000)
  try {
    const response = await fetchSafeUrl(endpoint, {
      headers: provider === 'gemini'
        ? { 'x-goog-api-key': clean(apiKey, 1000) }
        : { Authorization: `Bearer ${clean(apiKey, 1000)}` },
      signal: controller.signal,
      redirect: 'error',
    })
    if (!response.ok) {
      throw new ErrorResponse(`Provider model discovery failed (HTTP ${response.status})`, response.status === 401 || response.status === 403 ? 400 : 502)
    }
    const payload = await response.json()
    const rows = provider === 'gemini' ? payload.models : payload.data
    const models = Array.isArray(rows) ? rows.flatMap((item) => {
      const methods = item?.supportedGenerationMethods
      if (provider === 'gemini' && Array.isArray(methods) && !methods.includes('generateContent')) return []
      const modelId = clean(provider === 'gemini' ? String(item?.name || '').replace(/^models\//, '') : String(item?.id || ''), 160)
      return modelId ? [{ modelId, displayName: clean(item?.displayName || modelId, 160) }] : []
    }).slice(0, 3000) : []
    res.json({ success: true, data: models })
  } catch (error) {
    if (error instanceof ErrorResponse) throw error
    if (error.name === 'AbortError') throw new ErrorResponse('Provider model discovery timed out', 504)
    throw new ErrorResponse('Could not retrieve models from this provider. Check the URL and API key.', 502)
  } finally {
    clearTimeout(timeout)
  }
})

export const updateAIProvider = asyncHandler(async (req, res) => {
  const account = await AIProviderAccount.findById(req.params.id).select('+encryptedApiKey +apiKeys.encryptedKey')
  if (!account) throw new ErrorResponse('AI provider account not found', 404)
  const { name, model, apiKey, baseUrl, priority, routes, enabled, inputCostPerMillionUsd, outputCostPerMillionUsd } = req.body || {}

  if (name !== undefined) {
    const value = clean(name, 100)
    if (!value) throw new ErrorResponse('Provider name is required', 400)
    account.name = value
  }
  if (model !== undefined) {
    const value = clean(model, 160)
    if (!value) throw new ErrorResponse('Provider model is required', 400)
    const exists = await AIProviderModel.exists({ account: account._id, modelId: value })
    if (!exists) throw new ErrorResponse('Provider model is not registered for this account', 400)
    account.model = value
  }
  if (inputCostPerMillionUsd !== undefined || outputCostPerMillionUsd !== undefined) {
    const pricing = parsePricing(inputCostPerMillionUsd, outputCostPerMillionUsd)
    Object.assign(account, pricing)
    await AIProviderModel.updateMany({ account: account._id }, { $set: pricing })
  }
  if (baseUrl !== undefined) {
    const value = clean(baseUrl, 300)
    if (value) await validateSafeUrl(value)
    if (!value && account.provider === 'openai-compatible') {
      throw new ErrorResponse('Base URL is required for OpenAI-compatible providers', 400)
    }
    account.baseUrl = value
  }
  if (apiKey !== undefined && typeof apiKey !== 'string') throw new ErrorResponse('API key must be a string', 400)
  if (apiKey && !apiKey.includes('••••')) {
    // Backward compatible single-key edit: replaces the first key.
    ensureKeyList(account)
    const plaintext = clean(apiKey, 1000)
    if (!account.apiKeys.length) {
      account.apiKeys.push({ label: 'Key 1', encryptedKey: encryptSecret(plaintext), maskedKey: maskSecret(plaintext) })
    } else {
      account.apiKeys[0].encryptedKey = encryptSecret(plaintext)
      account.apiKeys[0].maskedKey = maskSecret(plaintext)
      resetKeyHealth(account.apiKeys[0])
    }
    account.needsAttention = false
    account.consecutiveFailures = 0
    account.lastErrorCode = ''
    account.cooldownUntil = null
    syncAccountAttention(account)
  }
  if (Number.isInteger(priority)) account.priority = Math.min(1000, Math.max(0, priority))
  if (routes !== undefined) {
    if (!Array.isArray(routes)) throw new ErrorResponse('Provider routes must be a list', 400)
    account.routes = validatedRoutes(routes).slice(0, 30)
  }
  if (enabled !== undefined) account.enabled = Boolean(enabled)
  await account.save()
  await logAction(req.user?._id, 'ADMIN_UPDATE_AI_PROVIDER', 'AIProviderAccount', account._id, { name: account.name, provider: account.provider })
  res.json({ success: true, data: publicAccount(account.toObject()) })
})

export const deleteAIProvider = asyncHandler(async (req, res) => {
  const account = await AIProviderAccount.findById(req.params.id).select('_id name provider')
  if (!account) throw new ErrorResponse('AI provider account not found', 404)
  const models = await AIProviderModel.find({ account: account._id }).select('_id').lean()
  const modelIds = models.map((model) => model._id)
  if (modelIds.length) {
    // A combo whose only remaining candidate is this provider would end up
    // empty, and an empty combo can never be activated again (the validator
    // requires >= 1 candidate). Block instead of silently bricking it.
    const emptied = await AIModelCombo.find({ 'candidates.model': { $in: modelIds } }).select('name candidates').lean()
    const names = emptied
      .filter((combo) => combo.candidates.every((candidate) => modelIds.some((id) => String(id) === String(candidate.model))))
      .map((combo) => combo.name)
    if (names.length) {
      throw new ErrorResponse(
        `Cannot remove this provider: it is the only model in combo(s) ${names.join(', ')}. Delete or re-point those combos first.`,
        409,
      )
    }
    await AIModelCombo.updateMany(
      { 'candidates.model': { $in: modelIds } },
      { $pull: { candidates: { model: { $in: modelIds } } }, $set: { active: false } },
    )
    await AIProviderModel.deleteMany({ _id: { $in: modelIds } })
  }
  const result = await AIProviderAccount.deleteOne({ _id: req.params.id })
  if (!result.deletedCount) throw new ErrorResponse('AI provider account not found', 404)
  await logAction(req.user?._id, 'ADMIN_DELETE_AI_PROVIDER', 'AIProviderAccount', req.params.id, { name: account.name, provider: account.provider })
  res.json({ success: true, data: null })
})

export const listAIModels = asyncHandler(async (req, res) => {
  const models = await AIProviderModel.find().populate('account', 'name provider baseUrl enabled').sort({ modelId: 1 }).lean()
  res.json({ success: true, data: models.map(publicModel) })
})

export const createAIModel = asyncHandler(async (req, res) => {
  const { account, modelId, displayName, capabilities, inputCostPerMillionUsd, outputCostPerMillionUsd, enabled } = req.body || {}
  if (!account || !clean(modelId, 160)) throw new ErrorResponse('Provider account and model are required', 400)
  const owner = await AIProviderAccount.findById(account).lean()
  if (!owner) throw new ErrorResponse('Provider account not found', 404)
  const pricing = parsePricing(inputCostPerMillionUsd, outputCostPerMillionUsd)
  const parsedCapabilities = parseCapabilities(capabilities)
  const model = await AIProviderModel.create({
    account,
    modelId: clean(modelId, 160),
    displayName: clean(displayName, 160),
    ...(parsedCapabilities ? { capabilities: parsedCapabilities } : {}),
    ...pricing,
    enabled: enabled !== false,
  })
  await logAction(req.user?._id, 'ADMIN_CREATE_AI_MODEL', 'AIProviderModel', model._id, { modelId: model.modelId, account })
  res.status(201).json({ success: true, data: publicModel(model.toObject()) })
})

export const updateAIModel = asyncHandler(async (req, res) => {
  const model = await AIProviderModel.findById(req.params.id)
  if (!model) throw new ErrorResponse('Provider model not found', 404)
  const { modelId, displayName, capabilities, inputCostPerMillionUsd, outputCostPerMillionUsd, enabled } = req.body || {}
  if (modelId !== undefined) model.modelId = clean(modelId, 160)
  if (displayName !== undefined) model.displayName = clean(displayName, 160)
  const parsedCapabilities = parseCapabilities(capabilities)
  if (parsedCapabilities !== undefined) {
    // Merge, not replace: an update that sends only { vision: true } must keep
    // the other flags as they were.
    model.capabilities = { ...(model.capabilities || {}), ...parsedCapabilities }
  }
  if (inputCostPerMillionUsd !== undefined || outputCostPerMillionUsd !== undefined) Object.assign(model, parsePricing(inputCostPerMillionUsd, outputCostPerMillionUsd))
  if (enabled !== undefined) model.enabled = Boolean(enabled)
  await model.save()
  await logAction(req.user?._id, 'ADMIN_UPDATE_AI_MODEL', 'AIProviderModel', model._id, { modelId: model.modelId, enabled: model.enabled })
  res.json({ success: true, data: publicModel(model.toObject()) })
})

export const deleteAIModel = asyncHandler(async (req, res) => {
  await AIModelCombo.updateMany(
    { 'candidates.model': req.params.id },
    { $pull: { candidates: { model: req.params.id } }, $set: { active: false } },
  )
  const result = await AIProviderModel.deleteOne({ _id: req.params.id })
  if (!result.deletedCount) throw new ErrorResponse('Provider model not found', 404)
  await logAction(req.user?._id, 'ADMIN_DELETE_AI_MODEL', 'AIProviderModel', req.params.id, {})
  res.json({ success: true, data: null })
})

const validateComboCandidates = async (candidates) => {
  if (!Array.isArray(candidates) || candidates.length < 1) {
    throw new ErrorResponse('Combo requires at least one candidate', 400)
  }
  const modelIds = candidates.map((candidate) => candidate.model)
  if (new Set(modelIds.map(String)).size !== modelIds.length) {
    throw new ErrorResponse('Duplicate model in combo', 400)
  }
  const models = await AIProviderModel.find({ _id: { $in: modelIds }, enabled: true }).select('account')
  const accountIds = [...new Set(models.map((model) => String(model.account)))]
  const enabledAccounts = accountIds.length
    ? await AIProviderAccount.countDocuments({ _id: { $in: accountIds }, enabled: true })
    : 0
  if (models.length !== modelIds.length || enabledAccounts !== accountIds.length) {
    throw new ErrorResponse('Combo contains an unavailable model', 400)
  }
}

const publicCombo = (combo) => ({
  _id: combo._id,
  name: combo.name,
  routes: combo.routes,
  candidates: combo.candidates,
  enabled: combo.enabled,
  active: combo.active,
  maxAttempts: combo.maxAttempts,
  timeoutMs: combo.timeoutMs,
  maxCostUsd: combo.maxCostUsd,
  version: combo.version,
})

export const listAICombos = asyncHandler(async (req, res) => {
  const combos = await AIModelCombo.find().populate({ path: 'candidates.model', populate: { path: 'account', select: 'name provider' } }).sort({ name: 1 }).lean()
  res.json({ success: true, data: combos.map(publicCombo) })
})

export const createAICombo = asyncHandler(async (req, res) => {
  const { name, routes, candidates, maxAttempts, timeoutMs, maxCostUsd, enabled, active } = req.body || {}
  if (!clean(name, 120) || !Array.isArray(candidates) || candidates.length < 1) throw new ErrorResponse('Combo name and candidates are required', 400)
  await validateComboCandidates(candidates)
  const normalizedRoutes = validatedRoutes(routes)
  if (active && normalizedRoutes.length) await AIModelCombo.updateMany({ routes: { $in: normalizedRoutes } }, { $set: { active: false } })
  const combo = await AIModelCombo.create({ name: clean(name, 120), routes: normalizedRoutes, candidates: candidates.map((candidate, index) => ({ model: candidate.model, order: index + 1, enabled: candidate.enabled !== false })), maxAttempts, timeoutMs, maxCostUsd, enabled: enabled !== false, active: Boolean(active) })
  await logAction(req.user?._id, 'ADMIN_CREATE_AI_COMBO', 'AIModelCombo', combo._id, { name: combo.name, routes: combo.routes, active: combo.active })
  res.status(201).json({ success: true, data: publicCombo(combo.toObject()) })
})

export const updateAICombo = asyncHandler(async (req, res) => {
  const combo = await AIModelCombo.findById(req.params.id)
  if (!combo) throw new ErrorResponse('AI model combo not found', 404)
  const { name, routes, candidates, maxAttempts, timeoutMs, maxCostUsd, enabled, active } = req.body || {}
  if (name !== undefined) {
    const value = clean(name, 120)
    if (!value) throw new ErrorResponse('Combo name is required', 400)
    combo.name = value
  }
  if (routes !== undefined) {
    if (!Array.isArray(routes)) throw new ErrorResponse('Combo routes must be a list', 400)
    combo.routes = validatedRoutes(routes)
  }
  if (candidates !== undefined) {
    await validateComboCandidates(candidates)
    combo.candidates = candidates.map((candidate, index) => ({ model: candidate.model, order: index + 1, enabled: candidate.enabled !== false }))
  }
  if (maxAttempts !== undefined) combo.maxAttempts = maxAttempts
  if (timeoutMs !== undefined) combo.timeoutMs = timeoutMs
  if (maxCostUsd !== undefined) combo.maxCostUsd = maxCostUsd
  if (enabled !== undefined) combo.enabled = Boolean(enabled)
  if (active !== undefined) combo.active = Boolean(active)
  if (combo.active && candidates === undefined) await validateComboCandidates(combo.candidates)
  if (combo.active && combo.routes.length) await AIModelCombo.updateMany({ _id: { $ne: combo._id }, routes: { $in: combo.routes } }, { $set: { active: false } })
  combo.version += 1
  await combo.save()
  const saved = await AIModelCombo.findById(combo._id).lean()
  await logAction(req.user?._id, 'ADMIN_UPDATE_AI_COMBO', 'AIModelCombo', combo._id, { name: saved.name, routes: saved.routes, active: saved.active })
  res.json({ success: true, data: publicCombo(saved) })
})

export const deleteAICombo = asyncHandler(async (req, res) => {
  const result = await AIModelCombo.deleteOne({ _id: req.params.id })
  if (!result.deletedCount) throw new ErrorResponse('AI model combo not found', 404)
  // A stale DEFAULT_AI_COMBO makes comboCandidates look up a deleted id on
  // every request before falling back to the active combo.
  await Config.updateOne({ key: 'DEFAULT_AI_COMBO', value: String(req.params.id) }, { $set: { value: '' } })
  await logAction(req.user?._id, 'ADMIN_DELETE_AI_COMBO', 'AIModelCombo', req.params.id, {})
  res.json({ success: true, data: null })
})

export const activateAICombo = asyncHandler(async (req, res) => {
  const combo = await AIModelCombo.findById(req.params.id)
  if (!combo) throw new ErrorResponse('AI model combo not found', 404)
  await validateComboCandidates(combo.candidates)
  // Deactivate and activate in one round trip, then read back the document:
  // two admins activating overlapping combos used to interleave the two
  // writes and leave both combos active.
  await AIModelCombo.updateMany(
    { _id: { $ne: combo._id }, routes: { $in: combo.routes } },
    { $set: { active: false } },
  )
  const activated = await AIModelCombo.findOneAndUpdate(
    { _id: combo._id },
    { $set: { active: true, enabled: true }, $inc: { version: 1 } },
    { returnDocument: 'after' },
  ).lean()
  if (!activated) throw new ErrorResponse('AI model combo not found', 404)
  await logAction(req.user?._id, 'ADMIN_ACTIVATE_AI_COMBO', 'AIModelCombo', activated._id, { name: activated.name, routes: activated.routes })
  res.json({ success: true, data: publicCombo(activated) })
})

async function testOneKey(account, key) {
  const started = Date.now()
  try {
    const result = await testAIProviderAccount(account, { encryptedKey: key.encryptedKey })
    resetKeyHealth(key)
    key.lastUsedAt = new Date()
    return { keyId: key._id, label: key.label, ok: true, latencyMs: Date.now() - started, provider: result.provider, model: result.model }
  } catch (error) {
    key.consecutiveFailures = (key.consecutiveFailures || 0) + 1
    key.lastErrorCode = String(error.code || `HTTP_${error.status || 502}`).slice(0, 80)
    key.lastErrorAt = new Date()
    if (isAuthFailure(error)) key.needsAttention = true
    return { keyId: key._id, label: key.label, ok: false, latencyMs: Date.now() - started, code: key.lastErrorCode, error }
  }
}

const publicTestResult = (result) => {
  const copy = { ...result }
  delete copy.error
  return copy
}

export const testAIProvider = asyncHandler(async (req, res) => {
  const account = await AIProviderAccount.findById(req.params.id).select('+encryptedApiKey +apiKeys.encryptedKey')
  if (!account) throw new ErrorResponse('AI provider account not found', 404)
  const started = Date.now()
  if (!account.apiKeys.length) {
    try {
      const result = await testAIProviderAccount(account)
      await AIProviderAccount.updateOne(
        { _id: account._id },
        { $set: { lastUsedAt: new Date(), consecutiveFailures: 0, lastErrorCode: '', needsAttention: false }, $unset: { cooldownUntil: 1 } },
      )
      res.json({ success: true, data: { ...result, latencyMs: Date.now() - started } })
    } catch (error) {
      await AIProviderAccount.updateOne(
        { _id: account._id },
        { $set: { lastErrorCode: String(error.code || `HTTP_${error.status || 502}`).slice(0, 80), lastErrorAt: new Date(), ...(isAuthFailure(error) ? { needsAttention: true } : {}) }, $inc: { consecutiveFailures: 1 } },
      )
      throw error
    }
    return
  }
  const keys = account.apiKeys.filter((key) => key.enabled !== false)
  if (!keys.length) throw new ErrorResponse('This provider has no enabled API key to test', 400)
  // Keys are independent, so they are tested in parallel; each one's health is updated.
  const results = await Promise.all(keys.map((key) => testOneKey(account, key)))
  const passed = results.filter((result) => result.ok)
  if (passed.length) {
    account.cooldownUntil = null
    account.consecutiveFailures = 0
    account.lastUsedAt = new Date()
  }
  syncAccountAttention(account)
  await account.save()
  if (!passed.length) {
    const failure = results[0].error
    failure.keyResults = results.map(publicTestResult)
    throw failure
  }
  res.json({ success: true, data: {
    provider: passed[0].provider,
    model: passed[0].model,
    latencyMs: Math.min(...passed.map((result) => result.latencyMs)),
    keysPassed: passed.length,
    keysTested: results.length,
    keyResults: results.map(publicTestResult),
    account: publicAccount(account.toObject()),
  } })
})

const loadAccountForKeys = async (id) => {
  const account = await AIProviderAccount.findById(id).select('+encryptedApiKey +apiKeys.encryptedKey')
  if (!account) throw new ErrorResponse('AI provider account not found', 404)
  ensureKeyList(account)
  return account
}

export const addAIProviderKey = asyncHandler(async (req, res) => {
  const account = await loadAccountForKeys(req.params.id)
  const plaintext = clean(req.body?.apiKey, 1000)
  if (!plaintext) throw new ErrorResponse('API key is required', 400)
  if (account.apiKeys.length >= MAX_API_KEYS_PER_ACCOUNT) {
    throw new ErrorResponse(`An AI provider account can hold at most ${MAX_API_KEYS_PER_ACCOUNT} API keys`, 400)
  }
  if (decryptedKeys(account).includes(plaintext)) throw new ErrorResponse('This API key is already saved for this provider', 409)
  account.apiKeys.push({
    label: cleanKeyLabel(req.body?.label) || `Key ${account.apiKeys.length + 1}`,
    encryptedKey: encryptSecret(plaintext),
    maskedKey: maskSecret(plaintext),
  })
  syncAccountAttention(account)
  await account.save()
  await logAction(req.user?._id, 'ADMIN_ADD_AI_PROVIDER_KEY', 'AIProviderAccount', account._id, { name: account.name, keyCount: account.apiKeys.length })
  res.status(201).json({ success: true, data: publicAccount(account.toObject()) })
})

export const updateAIProviderKey = asyncHandler(async (req, res) => {
  const account = await loadAccountForKeys(req.params.id)
  const key = findKey(account, req.params.keyId)
  if (!key) throw new ErrorResponse('API key not found', 404)
  const { label, enabled, apiKey } = req.body || {}
  if (label !== undefined) key.label = cleanKeyLabel(label) || key.label
  if (enabled !== undefined) key.enabled = Boolean(enabled)
  if (apiKey !== undefined) {
    const plaintext = clean(apiKey, 1000)
    if (!plaintext) throw new ErrorResponse('API key must not be empty', 400)
    const others = account.apiKeys.filter((item) => item !== key)
    if (decryptedKeys({ apiKeys: others }).includes(plaintext)) throw new ErrorResponse('This API key is already saved for this provider', 409)
    key.encryptedKey = encryptSecret(plaintext)
    key.maskedKey = maskSecret(plaintext)
    resetKeyHealth(key)
  }
  syncAccountAttention(account)
  await account.save()
  await logAction(req.user?._id, 'ADMIN_UPDATE_AI_PROVIDER_KEY', 'AIProviderAccount', account._id, { name: account.name, keyId: String(key._id), enabled: key.enabled, replaced: apiKey !== undefined })
  res.json({ success: true, data: publicAccount(account.toObject()) })
})

export const deleteAIProviderKey = asyncHandler(async (req, res) => {
  const account = await loadAccountForKeys(req.params.id)
  const key = findKey(account, req.params.keyId)
  if (!key) throw new ErrorResponse('API key not found', 404)
  if (account.apiKeys.length <= 1) {
    throw new ErrorResponse('A provider needs at least one API key. Add another key first, or remove the provider.', 400)
  }
  account.apiKeys.pull(key._id)
  syncAccountAttention(account)
  await account.save()
  await logAction(req.user?._id, 'ADMIN_DELETE_AI_PROVIDER_KEY', 'AIProviderAccount', account._id, { name: account.name, keyCount: account.apiKeys.length })
  res.json({ success: true, data: publicAccount(account.toObject()) })
})

export const testAIProviderKey = asyncHandler(async (req, res) => {
  const account = await loadAccountForKeys(req.params.id)
  const key = findKey(account, req.params.keyId)
  if (!key) throw new ErrorResponse('API key not found', 404)
  const result = await testOneKey(account, key)
  syncAccountAttention(account)
  await account.save()
  if (!result.ok) {
    result.error.keyResults = [publicTestResult(result)]
    throw result.error
  }
  res.json({ success: true, data: { ...publicTestResult(result), account: publicAccount(account.toObject()) } })
})

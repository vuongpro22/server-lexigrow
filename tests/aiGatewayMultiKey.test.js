import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import mongoose from 'mongoose'
import { MongoMemoryServer } from 'mongodb-memory-server'

const { groqCalls, groqBehavior, geminiCalls, geminiBehavior } = vi.hoisted(() => ({
  groqCalls: [],
  groqBehavior: vi.fn(),
  geminiCalls: [],
  geminiBehavior: vi.fn(),
}))

vi.mock('groq-sdk', () => ({
  default: class MockGroq {
    constructor(options) {
      this.chat = { completions: { create: async (body) => {
        groqCalls.push({ apiKey: options.apiKey, maxRetries: options.maxRetries, model: body.model })
        return groqBehavior(options.apiKey, body)
      } } }
    }
  },
}))
vi.mock('@google/generative-ai', () => ({
  GoogleGenerativeAI: class MockGemini {
    constructor(apiKey) { this.apiKey = apiKey }
    getGenerativeModel() {
      return { generateContent: async () => {
        geminiCalls.push(this.apiKey)
        return geminiBehavior(this.apiKey)
      } }
    }
  },
}))

import AIProviderAccount from '../src/models/AIProviderAccount.js'
import AIProviderModel from '../src/models/AIProviderModel.js'
import AIModelCombo from '../src/models/AIModelCombo.js'
import Config from '../src/models/Config.js'
import { completeAI } from '../src/services/aiGateway.service.js'
import { encryptSecret } from '../src/utils/secretCrypto.js'

const ok = (text = 'done') => ({ id: 'ok', choices: [{ message: { content: text } }], usage: { prompt_tokens: 1, completion_tokens: 1 } })
const httpError = (status, message = `HTTP ${status}`) => Object.assign(new Error(message), { status })
const connectionRefused = () => Object.assign(new Error('Connection error.'), {
  name: 'APIConnectionError',
  cause: Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }),
})
const timeoutError = () => Object.assign(new Error('Request timed out.'), { name: 'APIConnectionTimeoutError' })
const run = (route = 'essay_analysis') => completeAI({ route, messages: [{ role: 'user', content: 'hi' }] })

const keyDocs = (...secrets) => secrets.map((secret, index) => ({
  label: `Key ${index + 1}`,
  encryptedKey: encryptSecret(secret),
  maskedKey: `mask-${index + 1}`,
}))

async function groqAccount(name, secrets, extra = {}) {
  return AIProviderAccount.create({ name, provider: 'groq', model: `${name}-model`, routes: [], apiKeys: keyDocs(...secrets), ...extra })
}

async function readKeys(accountId) {
  const account = await AIProviderAccount.findById(accountId).lean()
  return Object.fromEntries(account.apiKeys.map((key) => [key.label, key]))
}

let mongo
beforeAll(async () => {
  mongo = await MongoMemoryServer.create()
  await mongoose.connect(mongo.getUri())
}, 60000)

afterAll(async () => {
  await mongoose.disconnect()
  await mongo?.stop()
})

beforeEach(async () => {
  delete process.env.GROQ_API_KEY
  delete process.env.GEMINI_API_KEY
  delete process.env.OPENAI_API_KEY
  groqCalls.length = 0
  geminiCalls.length = 0
  groqBehavior.mockReset()
  geminiBehavior.mockReset()
  await Promise.all([AIProviderAccount.deleteMany({}), AIProviderModel.deleteMany({}), AIModelCombo.deleteMany({}), Config.deleteMany({})])
})

describe('rotation inside one provider account', () => {
  it('moves to the next key when a key is expired and flags only that key', async () => {
    const account = await groqAccount('groq-a', ['expired-key', 'good-key'])
    groqBehavior.mockImplementation((apiKey) => {
      if (apiKey === 'expired-key') throw httpError(401, 'Invalid API Key')
      return ok()
    })

    const result = await run()

    expect(groqCalls.map((call) => call.apiKey)).toEqual(['expired-key', 'good-key'])
    expect(result.attempts.map((attempt) => [attempt.key, attempt.status, attempt.code])).toEqual([
      ['Key 1', 'failure', 'AUTH_FAILED'],
      ['Key 2', 'success', undefined],
    ])
    expect(JSON.stringify(result)).not.toMatch(/expired-key|good-key/)
    const keys = await readKeys(account._id)
    expect(keys['Key 1']).toMatchObject({ needsAttention: true, lastErrorCode: 'AUTH_FAILED', consecutiveFailures: 1 })
    expect(keys['Key 2']).toMatchObject({ needsAttention: false, consecutiveFailures: 0 })
    expect(keys['Key 2'].lastUsedAt).toBeInstanceOf(Date)
    const stored = await AIProviderAccount.findById(account._id).lean()
    expect(stored.needsAttention).toBe(false)
    expect(stored.cooldownUntil ?? null).toBeNull()
  })

  it('skips an expired key on later requests', async () => {
    const account = await groqAccount('groq-a', ['expired-key', 'good-key'])
    groqBehavior.mockImplementation((apiKey) => {
      if (apiKey === 'expired-key') throw httpError(401)
      return ok()
    })
    await run()
    groqCalls.length = 0

    await run()

    expect(groqCalls.map((call) => call.apiKey)).toEqual(['good-key'])
    expect((await readKeys(account._id))['Key 1'].needsAttention).toBe(true)
  })

  it('cools down a throttled key, uses a sibling key and comes back to it after the cooldown', async () => {
    const account = await groqAccount('groq-a', ['busy-key', 'spare-key'])
    groqBehavior.mockImplementationOnce(() => { throw httpError(429, 'rate limit reached') }).mockImplementation(() => ok())

    const first = await run()
    expect(first.attempts.map((attempt) => attempt.code ?? 'ok')).toEqual(['RATE_LIMITED', 'ok'])
    const keys = await readKeys(account._id)
    expect(keys['Key 1'].cooldownUntil.getTime()).toBeGreaterThan(Date.now())
    expect(keys['Key 1'].needsAttention).toBe(false)

    groqCalls.length = 0
    await run()
    expect(groqCalls.map((call) => call.apiKey)).toEqual(['spare-key'])

    await AIProviderAccount.updateOne({ _id: account._id }, { $set: { 'apiKeys.0.cooldownUntil': new Date(Date.now() - 1000) } })
    groqCalls.length = 0
    await run()
    expect(groqCalls.map((call) => call.apiKey)).toEqual(['busy-key'])
  })

  it('spreads requests across keys, least recently used first', async () => {
    await groqAccount('groq-a', ['key-one', 'key-two', 'key-three'])
    groqBehavior.mockImplementation(() => ok())

    for (let index = 0; index < 4; index += 1) await run()

    expect(groqCalls.map((call) => call.apiKey)).toEqual(['key-one', 'key-two', 'key-three', 'key-one'])
  })

  it('ignores disabled keys', async () => {
    const account = await groqAccount('groq-a', ['off-key', 'on-key'])
    await AIProviderAccount.updateOne({ _id: account._id }, { $set: { 'apiKeys.0.enabled': false } })
    groqBehavior.mockImplementation(() => ok())

    await run()

    expect(groqCalls.map((call) => call.apiKey)).toEqual(['on-key'])
  })

  it('flags the account once every key has failed authentication', async () => {
    const account = await groqAccount('groq-a', ['dead-1', 'dead-2'])
    groqBehavior.mockImplementation(() => { throw httpError(403, 'Forbidden') })

    await expect(run()).rejects.toMatchObject({ code: 'AUTH_FAILED' })

    expect(groqCalls).toHaveLength(2)
    const stored = await AIProviderAccount.findById(account._id).lean()
    expect(stored).toMatchObject({ needsAttention: true, lastErrorCode: 'ALL_KEYS_FAILED' })
    groqCalls.length = 0
    await expect(run()).rejects.toMatchObject({ code: 'AI_NOT_CONFIGURED' })
    expect(groqCalls).toHaveLength(0)
  })

  it('tries at most five keys of one provider per request', async () => {
    await groqAccount('groq-a', ['k1', 'k2', 'k3', 'k4', 'k5', 'k6', 'k7'])
    groqBehavior.mockImplementation(() => { throw httpError(429) })

    await expect(run()).rejects.toMatchObject({ code: 'RATE_LIMITED' })

    expect(groqCalls.map((call) => call.apiKey)).toEqual(['k1', 'k2', 'k3', 'k4', 'k5'])
  })

  it('turns off the Groq SDK retries so the gateway can switch keys', async () => {
    await groqAccount('groq-a', ['only-key'])
    groqBehavior.mockImplementation(() => ok())
    await run()
    expect(groqCalls[0].maxRetries).toBe(0)
  })

  it('keeps legacy single-key accounts working and flags them on auth failure', async () => {
    const legacy = await AIProviderAccount.create({ name: 'legacy', provider: 'groq', model: 'legacy-model', encryptedApiKey: encryptSecret('legacy-key') })
    const backup = await groqAccount('backup', ['backup-key'], { priority: 200 })
    groqBehavior.mockImplementation((apiKey) => {
      if (apiKey === 'legacy-key') throw httpError(401)
      return ok()
    })

    const result = await run()

    expect(groqCalls.map((call) => call.apiKey)).toEqual(['legacy-key', 'backup-key'])
    expect(result.account).toBe('backup')
    expect(await AIProviderAccount.findById(legacy._id).lean()).toMatchObject({ needsAttention: true, lastErrorCode: 'AUTH_FAILED' })
    expect(await AIProviderAccount.findById(backup._id).lean()).toMatchObject({ needsAttention: false })
  })
})

describe('rotation across providers in a combo', () => {
  async function comboOf(groqSecrets, geminiSecrets) {
    const groq = await groqAccount('groq-main', groqSecrets)
    const gemini = await AIProviderAccount.create({ name: 'gemini-main', provider: 'gemini', model: 'gemini-2.5-flash', apiKeys: keyDocs(...geminiSecrets) })
    const groqModel = await AIProviderModel.create({ account: groq._id, modelId: 'llama-test' })
    const geminiModel = await AIProviderModel.create({ account: gemini._id, modelId: 'gemini-2.5-flash', capabilities: { jsonMode: true, structuredSchema: true } })
    await AIModelCombo.create({
      name: 'main', routes: ['essay_analysis'], active: true, enabled: true, maxAttempts: 3,
      candidates: [{ model: groqModel._id, order: 1 }, { model: geminiModel._id, order: 2 }],
    })
    return { groq, gemini }
  }
  const geminiOk = () => ({ response: { text: () => 'gemini-done', usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 } } })

  it('uses every key of the first provider before moving to the next provider', async () => {
    await comboOf(['groq-1', 'groq-2'], ['gem-1'])
    groqBehavior.mockImplementation(() => { throw httpError(429) })
    geminiBehavior.mockImplementation(() => geminiOk())

    const result = await run()

    expect(groqCalls.map((call) => call.apiKey)).toEqual(['groq-1', 'groq-2'])
    expect(geminiCalls).toEqual(['gem-1'])
    expect(result.provider).toBe('gemini')
    expect(result.text).toBe('gemini-done')
  })

  it('skips the remaining keys of a provider that cannot be reached', async () => {
    const { groq } = await comboOf(['groq-1', 'groq-2'], ['gem-1'])
    groqBehavior.mockImplementation(() => { throw connectionRefused() })
    geminiBehavior.mockImplementation(() => geminiOk())

    const result = await run()

    expect(groqCalls.map((call) => call.apiKey)).toEqual(['groq-1'])
    expect(result.attempts[0]).toMatchObject({ code: 'CONNECTION_FAILED', scope: 'provider', mayHaveProcessed: false })
    expect(result.provider).toBe('gemini')
    const stored = await AIProviderAccount.findById(groq._id).lean()
    expect(stored.cooldownUntil.getTime()).toBeGreaterThan(Date.now())
    expect(stored.apiKeys.every((key) => !key.needsAttention && !key.cooldownUntil)).toBe(true)
  })

  it('moves to the second provider key when the first Gemini key is invalid', async () => {
    await comboOf(['groq-1'], ['gem-bad', 'gem-good'])
    groqBehavior.mockImplementation(() => { throw httpError(401) })
    geminiBehavior.mockImplementation((apiKey) => {
      if (apiKey === 'gem-bad') throw httpError(400, '[400 Bad Request] API key not valid. Please pass a valid API key. [API_KEY_INVALID]')
      return geminiOk()
    })

    const result = await run()

    expect(geminiCalls).toEqual(['gem-bad', 'gem-good'])
    expect(result.attempts.map((attempt) => attempt.code ?? 'ok')).toEqual(['AUTH_FAILED', 'AUTH_FAILED', 'ok'])
  })

  it('does not fail over after a timeout that the provider may have processed (AI-09)', async () => {
    await comboOf(['groq-1', 'groq-2'], ['gem-1'])
    groqBehavior.mockImplementation(() => { throw timeoutError() })

    await expect(run()).rejects.toMatchObject({ code: 'TIMEOUT' })

    expect(groqCalls).toHaveLength(1)
    expect(geminiCalls).toHaveLength(0)
  })
})

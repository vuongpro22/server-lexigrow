import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import mongoose from 'mongoose'
import express from 'express'
import request from 'supertest'
import { MongoMemoryServer } from 'mongodb-memory-server'

const { groqCalls, groqBehavior } = vi.hoisted(() => ({
  groqCalls: [],
  groqBehavior: vi.fn(),
}))

vi.mock('../src/utils/auditLogger.js', () => ({ logAction: vi.fn() }))
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

import AIProviderAccount from '../src/models/AIProviderAccount.js'
import Config from '../src/models/Config.js'
import { completeAI } from '../src/services/aiGateway.service.js'
import { encryptSecret } from '../src/utils/secretCrypto.js'
import {
  createAIProvider,
  listAIProviders,
  updateAIProvider,
  testAIProvider,
  addAIProviderKey,
  updateAIProviderKey,
  deleteAIProviderKey,
  testAIProviderKey,
} from '../src/controllers/aiProvider.controller.js'

const ok = (text = 'done') => ({ id: 'ok', choices: [{ message: { content: text } }], usage: { prompt_tokens: 1, completion_tokens: 1 } })
const httpError = (status, message = `HTTP ${status}`) => Object.assign(new Error(message), { status })
const run = (route = 'essay_analysis') => completeAI({ route, messages: [{ role: 'user', content: 'hi' }] })

let mongo
const app = express()
app.use(express.json())
app.get('/providers', listAIProviders)
app.post('/providers', createAIProvider)
app.patch('/providers/:id', updateAIProvider)
app.post('/providers/:id/test', testAIProvider)
app.post('/providers/:id/keys', addAIProviderKey)
app.patch('/providers/:id/keys/:keyId', updateAIProviderKey)
app.delete('/providers/:id/keys/:keyId', deleteAIProviderKey)
app.post('/providers/:id/keys/:keyId/test', testAIProviderKey)
app.use((error, req, res, next) => {
  void next
  res.status(error.statusCode || error.status || 500).json({ message: error.message, code: error.code, keyResults: error.keyResults })
})

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
  groqBehavior.mockReset()
  await Promise.all([AIProviderAccount.deleteMany({}), Config.deleteMany({})])
})

describe('admin API for provider keys', () => {
  async function createProvider(body = {}) {
    return request(app).post('/providers').send({ name: 'Groq pool', provider: 'groq', model: 'llama-test', apiKeys: ['gsk_first_secret_111', { apiKey: 'gsk_second_secret_222', label: 'Backup' }], ...body })
  }

  it('creates an account with several keys and never returns the secrets', async () => {
    const res = await createProvider()
    expect(res.status).toBe(201)
    expect(res.body.data.keyCount).toBe(2)
    expect(res.body.data.apiKeys.map((key) => key.label)).toEqual(['Key 1', 'Backup'])
    expect(res.body.data.apiKeys[0].maskedKey).toBe('gsk••••••••111')

    const list = await request(app).get('/providers')
    expect(JSON.stringify(list.body)).not.toMatch(/first_secret|second_secret|encryptedKey/)
    expect(list.body.data[0].apiKeys).toHaveLength(2)
  })

  it('adds a key, rejects duplicates and enforces at least one key', async () => {
    const created = await createProvider({ apiKeys: ['gsk_only_secret_999'] })
    const id = created.body.data._id

    const added = await request(app).post(`/providers/${id}/keys`).send({ apiKey: 'gsk_new_secret_555', label: 'Team B' })
    expect(added.status).toBe(201)
    expect(added.body.data.apiKeys.map((key) => key.label)).toEqual(['Key 1', 'Team B'])

    const duplicate = await request(app).post(`/providers/${id}/keys`).send({ apiKey: 'gsk_only_secret_999' })
    expect(duplicate.status).toBe(409)

    const firstKeyId = added.body.data.apiKeys[0]._id
    const removed = await request(app).delete(`/providers/${id}/keys/${firstKeyId}`)
    expect(removed.status).toBe(200)
    expect(removed.body.data.apiKeys.map((key) => key.label)).toEqual(['Team B'])

    const last = await request(app).delete(`/providers/${id}/keys/${removed.body.data.apiKeys[0]._id}`)
    expect(last.status).toBe(400)
  })

  it('flags the account when every key is disabled and clears it on re-enable', async () => {
    const created = await createProvider({ apiKeys: ['gsk_only_secret_999'] })
    const { _id: id, apiKeys } = created.body.data

    const disabled = await request(app).patch(`/providers/${id}/keys/${apiKeys[0]._id}`).send({ enabled: false })
    expect(disabled.body.data).toMatchObject({ needsAttention: true, lastErrorCode: 'NO_USABLE_KEY' })

    const enabled = await request(app).patch(`/providers/${id}/keys/${apiKeys[0]._id}`).send({ enabled: true })
    expect(enabled.body.data).toMatchObject({ needsAttention: false, lastErrorCode: '' })
  })

  it('replacing an expired key clears its health and the account flag', async () => {
    const created = await createProvider({ apiKeys: ['gsk_only_secret_999'] })
    const { _id: id, apiKeys } = created.body.data
    await AIProviderAccount.updateOne({ _id: id }, { $set: { needsAttention: true, lastErrorCode: 'ALL_KEYS_FAILED', 'apiKeys.0.needsAttention': true, 'apiKeys.0.lastErrorCode': 'AUTH_FAILED' } })

    const res = await request(app).patch(`/providers/${id}/keys/${apiKeys[0]._id}`).send({ apiKey: 'gsk_fresh_secret_777' })

    expect(res.body.data).toMatchObject({ needsAttention: false })
    expect(res.body.data.apiKeys[0]).toMatchObject({ needsAttention: false, lastErrorCode: '', maskedKey: 'gsk••••••••777' })
  })

  it('migrates a legacy single key the first time its keys are managed', async () => {
    const legacy = await AIProviderAccount.create({ name: 'legacy', provider: 'groq', model: 'legacy-model', encryptedApiKey: encryptSecret('gsk_legacy_secret_000'), consecutiveFailures: 2, lastErrorCode: 'RATE_LIMITED' })

    const list = await request(app).get('/providers')
    expect(list.body.data[0].apiKeys).toEqual([expect.objectContaining({ _id: 'legacy', label: 'Key 1', maskedKey: 'gsk••••••••000', consecutiveFailures: 2 })])

    const added = await request(app).post(`/providers/${legacy._id}/keys`).send({ apiKey: 'gsk_extra_secret_333' })
    expect(added.status).toBe(201)
    expect(added.body.data.apiKeys.map((key) => [key.label, key.maskedKey, key.consecutiveFailures])).toEqual([
      ['Key 1', 'gsk••••••••000', 2],
      ['Key 2', 'gsk••••••••333', 0],
    ])
    const stored = await AIProviderAccount.findById(legacy._id).select('+encryptedApiKey').lean()
    expect(stored.encryptedApiKey).toBeUndefined()
    expect(stored).toMatchObject({ consecutiveFailures: 0, lastErrorCode: '' })

    groqBehavior.mockImplementation(() => ok())
    // The migrated key stays usable: both keys are unused, so stored order wins.
    await run()
    expect(groqCalls.map((call) => call.apiKey)).toEqual(['gsk_legacy_secret_000'])
  })

  it('tests every enabled key and records each result', async () => {
    const created = await createProvider()
    groqBehavior.mockImplementation((apiKey) => {
      if (apiKey === 'gsk_first_secret_111') throw httpError(401, 'Invalid API Key')
      return ok('OK')
    })

    const res = await request(app).post(`/providers/${created.body.data._id}/test`)

    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ keysPassed: 1, keysTested: 2 })
    expect(res.body.data.keyResults.map((result) => [result.label, result.ok])).toEqual([['Key 1', false], ['Backup', true]])
    expect(res.body.data.account.apiKeys[0]).toMatchObject({ needsAttention: true })
    expect(res.body.data.account.needsAttention).toBe(false)
  })

  it('reports a failed test when no key works', async () => {
    const created = await createProvider()
    groqBehavior.mockImplementation(() => { throw httpError(401, 'Invalid API Key') })

    const res = await request(app).post(`/providers/${created.body.data._id}/test`)

    expect(res.status).toBe(401)
    expect(res.body.keyResults).toHaveLength(2)
    const stored = await AIProviderAccount.findById(created.body.data._id).lean()
    expect(stored).toMatchObject({ needsAttention: true, lastErrorCode: 'ALL_KEYS_FAILED' })
  })

  it('tests a single key', async () => {
    const created = await createProvider()
    groqBehavior.mockImplementation(() => ok('OK'))
    const keyId = created.body.data.apiKeys[1]._id

    const res = await request(app).post(`/providers/${created.body.data._id}/keys/${keyId}/test`)

    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ label: 'Backup', ok: true })
    expect(groqCalls.map((call) => call.apiKey)).toEqual(['gsk_second_secret_222'])
  })
})

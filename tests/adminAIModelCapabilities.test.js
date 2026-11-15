import { describe, it, expect, vi, beforeEach } from 'vitest'

/* Capabilities are the only thing the gateway uses to decide whether a model can
   handle vision/JSON, so an admin payload must not be able to smuggle arbitrary
   keys onto the document. */

const store = { account: null, model: null }

vi.mock('../src/models/AIProviderAccount.js', () => ({
  default: { findById: vi.fn(), find: vi.fn(), findOne: vi.fn() },
}))
vi.mock('../src/models/AIProviderModel.js', () => ({
  default: {
    create: vi.fn(),
    findById: vi.fn(),
    find: vi.fn(),
  },
}))
vi.mock('../src/models/AIModelCombo.js', () => ({ default: { updateMany: vi.fn(), find: vi.fn() } }))
vi.mock('../src/utils/auditLogger.js', () => ({ logAction: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../src/services/aiGateway.service.js', () => ({ testAIProviderAccount: vi.fn() }))

import AIProviderAccount from '../src/models/AIProviderAccount.js'
import AIProviderModel from '../src/models/AIProviderModel.js'
import { createAIModel, updateAIModel } from '../src/controllers/aiProvider.controller.js'

const mockRes = () => ({ status: vi.fn().mockReturnThis(), json: vi.fn() })

beforeEach(() => {
  vi.clearAllMocks()
  AIProviderAccount.findById.mockReturnValue({ lean: vi.fn().mockResolvedValue({ _id: 'acc_1' }) })
  AIProviderModel.create.mockImplementation(async (doc) => ({
    _id: 'model_1',
    ...doc,
    toObject() { return { _id: 'model_1', ...doc } },
  }))
})

describe('createAIModel — capabilities validation', () => {
  const post = (capabilities) => {
    const res = mockRes()
    const next = vi.fn()
    return createAIModel({ body: { account: 'acc_1', modelId: 'm1', capabilities }, user: { _id: 'admin_1' } }, res, next)
      .then(() => ({ res, next }))
  }

  it('rejects a non-object capabilities value', async () => {
    const { next } = await post('vision')
    expect(next).toHaveBeenCalledTimes(1)
    expect(next.mock.calls[0][0].statusCode).toBe(400)
    expect(AIProviderModel.create).not.toHaveBeenCalled()
  })

  it('rejects an unknown capability key', async () => {
    const { next } = await post({ vision: true, secretFlag: true })
    expect(next.mock.calls[0][0].statusCode).toBe(400)
    expect(AIProviderModel.create).not.toHaveBeenCalled()
  })

  it('keeps only the declared flags and coerces them to booleans', async () => {
    const { next } = await post({ vision: 'yes', jsonMode: 0 })
    expect(next).not.toHaveBeenCalled()
    const doc = AIProviderModel.create.mock.calls[0][0]
    expect(doc.capabilities).toEqual({ jsonMode: false, vision: true })
  })

  it('omits capabilities entirely when the field is absent so schema defaults apply', async () => {
    const { next } = await post(undefined)
    expect(next).not.toHaveBeenCalled()
    expect(AIProviderModel.create.mock.calls[0][0]).not.toHaveProperty('capabilities')
  })
})

describe('updateAIModel — capabilities are merged, not replaced', () => {
  it('keeps the untouched flags and rejects unknown keys', async () => {
    store.model = {
      _id: 'model_1',
      modelId: 'm1',
      capabilities: { jsonMode: true, structuredSchema: false, text: true, vision: false },
      save: vi.fn().mockResolvedValue(undefined),
      toObject() { return this },
    }
    AIProviderModel.findById.mockResolvedValue(store.model)

    const res = mockRes()
    const next = vi.fn()
    await updateAIModel({ params: { id: 'model_1' }, body: { capabilities: { vision: true } }, user: { _id: 'admin_1' } }, res, next)

    expect(next).not.toHaveBeenCalled()
    expect(store.model.capabilities).toEqual({ jsonMode: true, structuredSchema: false, text: true, vision: true })

    const badNext = vi.fn()
    await updateAIModel({ params: { id: 'model_1' }, body: { capabilities: { bogusKey: 1 } }, user: { _id: 'admin_1' } }, mockRes(), badNext)
    expect(badNext.mock.calls[0][0].statusCode).toBe(400)
  })
})

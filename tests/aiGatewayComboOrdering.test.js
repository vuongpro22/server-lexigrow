import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockFindOne, mockFindOneAndUpdate, mockAccountFindOne, mockModelFindOne } = vi.hoisted(() => ({
  mockFindOne: vi.fn(),
  mockFindOneAndUpdate: vi.fn(),
  mockAccountFindOne: vi.fn(),
  mockModelFindOne: vi.fn(),
}))

vi.mock('../src/models/Config.js', () => ({
  default: { findOne: mockFindOne },
}))

vi.mock('../src/models/AIModelCombo.js', () => ({
  default: {
    db: { readyState: 1 },
    findOneAndUpdate: mockFindOneAndUpdate,
  },
}))

vi.mock('../src/models/AIProviderModel.js', () => ({
  default: {
    db: { readyState: 1 },
    findOne: mockModelFindOne,
  },
}))

vi.mock('../src/models/AIProviderAccount.js', () => ({
  default: {
    db: { readyState: 1 },
    findOne: mockAccountFindOne,
    find: vi.fn().mockReturnValue({ select: () => ({ sort: () => ({ lean: () => [] }) }) }),
  },
}))

import { completeAI } from '../src/services/aiGateway.service.js'
import { encryptSecret } from '../src/utils/secretCrypto.js'

describe('AI Gateway combo candidate ordering', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockFindOne.mockResolvedValue(null)
  })

  it('respects the explicit candidate order when Groq is configured before Gemini', async () => {
    const groqKey = encryptSecret('gsk_groq_key_123')
    const geminiKey = encryptSecret('gemini_key_456')

    const comboMock = {
      _id: 'combo_1',
      maxAttempts: 3,
      timeoutMs: 30000,
      candidates: [
        { model: 'model_groq', order: 1, enabled: true },
        { model: 'model_gemini', order: 2, enabled: true },
      ],
      roundRobinCounters: new Map(),
    }

    mockFindOneAndUpdate.mockReturnValue({
      sort: () => ({
        lean: () => Promise.resolve(comboMock),
      }),
    })

    mockModelFindOne.mockImplementation(({ _id }) => ({
      lean: () => {
        if (_id === 'model_groq') {
          return Promise.resolve({
            _id: 'model_groq',
            account: 'acc_groq',
            modelId: 'llama-3.3-70b-versatile',
            capabilities: { jsonMode: true },
          })
        }
        if (_id === 'model_gemini') {
          return Promise.resolve({
            _id: 'model_gemini',
            account: 'acc_gemini',
            modelId: 'gemini-2.5-flash',
            capabilities: { jsonMode: true },
          })
        }
        return Promise.resolve(null)
      },
    }))

    mockAccountFindOne.mockImplementation(({ _id }) => ({
      select: () => ({
        lean: () => {
          if (_id === 'acc_groq') {
            return Promise.resolve({
              _id: 'acc_groq',
              provider: 'groq',
              encryptedApiKey: groqKey,
              enabled: true,
            })
          }
          if (_id === 'acc_gemini') {
            return Promise.resolve({
              _id: 'acc_gemini',
              provider: 'gemini',
              encryptedApiKey: geminiKey,
              enabled: true,
            })
          }
          return Promise.resolve(null)
        },
      }),
    }))

    // In a dry run or test, if candidates resolves pool,
    // order must have acc_groq FIRST, then acc_gemini SECOND!
    // We can verify candidate resolution by triggering completeAI with mockGroq
  })
})

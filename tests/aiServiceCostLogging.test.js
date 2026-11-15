import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  logCreate: vi.fn(),
  completion: vi.fn(),
  sessionUpdate: vi.fn(),
  config: vi.fn(),
  cacheGet: vi.fn(),
  cacheSet: vi.fn(),
  essayFind: vi.fn(),
}))
vi.mock('../src/models/AILog.js', () => ({ default: { create: mocks.logCreate } }))
vi.mock('../src/models/LearningSession.js', () => ({ default: { updateOne: mocks.sessionUpdate } }))
vi.mock('../src/services/aiRelayClient.service.js', () => ({ completeThroughRelay: mocks.completion }))
vi.mock('../src/services/ai.service.js', () => ({ getConfigValue: mocks.config }))
vi.mock('../src/services/cache.service.js', () => ({ default: {
  hashKey: (_prefix, value) => JSON.stringify(value),
  get: mocks.cacheGet,
  set: mocks.cacheSet,
} }))
vi.mock('../src/models/Essay.js', () => ({ default: { find: mocks.essayFind } }))

import { generatePracticeQuestions } from '../src/services/practiceQuestion.service.js'
import { generateWritingPrompt } from '../src/services/writingPrompt.service.js'

const practiceQuestions = { questions: [
  { word: 'adaptable', type: 'multiple_choice', title: 'What does adaptable mean?', sentence: 'An adaptable person changes plans easily.', options: ['Able to adjust', 'Very tired', 'A kind of meal', 'A short trip'], correctAnswer: 'Able to adjust' },
  { word: 'adaptable', type: 'fill_in_blank', title: 'Choose the word', sentence: 'She is _______ when plans change.', options: ['adaptable', 'sleepy', 'garden', 'book'], correctAnswer: 'adaptable' },
] }
const session = {
  _id: 'session-1', student: 'student-1', theme: 'Daily life', level: 'B1',
  mode: 'static', setVersion: '2026-01-01', targetWords: ['routine', 'improve'],
}
const essayQuery = { select: vi.fn().mockReturnThis(), sort: vi.fn().mockReturnThis(), limit: vi.fn().mockReturnThis(), lean: vi.fn() }

beforeEach(() => {
  vi.resetAllMocks()
  mocks.logCreate.mockResolvedValue({})
  mocks.sessionUpdate.mockResolvedValue({ modifiedCount: 1 })
  mocks.config.mockResolvedValue('configured-model')
  mocks.cacheGet.mockResolvedValue(null)
  mocks.cacheSet.mockResolvedValue(undefined)
  mocks.essayFind.mockReturnValue(essayQuery)
  essayQuery.select.mockReturnThis()
  essayQuery.sort.mockReturnThis()
  essayQuery.limit.mockReturnThis()
  essayQuery.lean.mockResolvedValue([])
  mocks.completion.mockResolvedValue({
    text: JSON.stringify(practiceQuestions),
    usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
    cost: { cost: 0.00125, pricingSource: 'account' },
    provider: 'groq', model: 'custom-model', requestId: 'stable-request-1',
  })
})

const generatePractice = (id) => generatePracticeQuestions({
  _id: id, theme: 'Daily life', level: 'B1',
  targetWords: [{ word: 'adaptable', definitionVi: 'linh hoạt' }], practiceQuestions: [],
}, { bypassCache: true })

describe('shared AI cost metadata logging', () => {
  it('records gateway cost and provider metadata for practice questions', async () => {
    const result = await generatePractice('507f1f77bcf86cd799439021')
    expect(result.source).toBe('ai')
    expect(mocks.logCreate).toHaveBeenCalledWith(expect.objectContaining({
      model: 'custom-model', provider: 'groq', requestId: 'stable-request-1',
      costEstimate: 0.00125, pricingSource: 'account', usageAvailable: true,
    }))
  })

  it('stores unknown practice cost as null when gateway has no price metadata', async () => {
    mocks.completion.mockResolvedValueOnce({
      text: JSON.stringify(practiceQuestions), usage: null,
      cost: { cost: null, pricingSource: 'unknown' },
      provider: 'groq', model: 'new-model', requestId: 'request-unknown-cost',
    })
    await generatePractice('507f1f77bcf86cd799439022')
    expect(mocks.logCreate).toHaveBeenCalledWith(expect.objectContaining({
      costEstimate: null, pricingSource: 'unknown', usageAvailable: false,
    }))
  })

  it('records writing-prompt gateway metadata and unknown prices faithfully', async () => {
    mocks.completion.mockResolvedValueOnce({
      text: JSON.stringify({ prompt: 'Write about a daily routine using each target word.' }),
      usage: { prompt_tokens: 20, completion_tokens: 30, total_tokens: 50 },
      cost: { cost: null, pricingSource: 'unknown' },
      provider: 'groq', model: 'writing-model', requestId: 'writing-request-1',
    })
    const result = await generateWritingPrompt(session, { bypassCache: true })
    expect(result.source).toBe('ai')
    expect(mocks.logCreate).toHaveBeenCalledWith(expect.objectContaining({
      model: 'writing-model', provider: 'groq', requestId: 'writing-request-1',
      costEstimate: null, pricingSource: 'unknown', usageAvailable: true,
    }))
  })
})

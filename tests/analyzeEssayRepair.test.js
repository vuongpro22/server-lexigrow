import { vi, describe, it, expect, beforeEach } from 'vitest'

vi.mock('../src/config/db.js', () => ({ default: vi.fn().mockResolvedValue() }))
vi.mock('../src/models/AILog.js', () => ({ default: { create: vi.fn().mockResolvedValue(true) } }))
vi.mock('../src/models/Config.js', () => ({ default: { findOne: vi.fn().mockResolvedValue(null) } }))
vi.mock('../src/services/aiRelayClient.service.js', () => ({ completeThroughRelay: vi.fn() }))

import { completeThroughRelay } from '../src/services/aiRelayClient.service.js'
import { analyzeEssay } from '../src/services/ai.service.js'

const ESSAY = 'Every morning my daily routine starts with a short commute to school.'
const VALID = {
  overallScore: 7.3,
  scores: { vocabularyDiversity: 0.62, lexicalResource: 7, grammarAccuracy: 8, coherence: 7, complexityIndex: 7, promptAdherence: 7.5 },
  suggestions: [{ type: 'improvement', text: 'Vary sentence openings.', quote: 'Every morning', targetWord: '', suggestedRevision: '', errorCategory: 'sentence_structure' }],
  writingStats: { avgSentenceLength: 11, uniqueWords: 10 },
  learningPatterns: { paddedSentences: false, plagiarismDetected: false, learningStatus: 'stable', feedback: 'Steady.' },
  nextEssaySuggestions: { transitionWords: [], sentenceStructures: [], generalTips: 'Use linking words.' },
}
const reply = (text) => ({ text, usage: null, provider: 'groq', model: 'test-model' })

describe('analyzeEssay repair round', () => {
  beforeEach(() => { completeThroughRelay.mockReset() })

  it('asks the model to repair invalid JSON once and uses the repaired grading', async () => {
    completeThroughRelay
      .mockResolvedValueOnce(reply('{"overallScore": 7, "scores": {'))
      .mockResolvedValueOnce(reply(JSON.stringify(VALID)))

    const analysis = await analyzeEssay(ESSAY, null, '', null, 'req-1', 'en')

    expect(analysis.isFallback).toBe(false)
    expect(completeThroughRelay).toHaveBeenCalledTimes(2)
    const repairCall = completeThroughRelay.mock.calls[1][0]
    expect(repairCall.requestId).toBe('req-1:repair')
    expect(repairCall.messages.at(-2)).toMatchObject({ role: 'assistant', content: '{"overallScore": 7, "scores": {' })
    expect(repairCall.messages.at(-1).content).toMatch(/rejected/)
    expect(analysis.suggestions[0].errorCategory).toBe('sentence_structure')
  })

  it('repairs a reply that breaks the grading contract', async () => {
    completeThroughRelay
      .mockResolvedValueOnce(reply(JSON.stringify({ ...VALID, scores: { ...VALID.scores, grammarAccuracy: 42 } })))
      .mockResolvedValueOnce(reply(JSON.stringify(VALID)))

    const analysis = await analyzeEssay(ESSAY, null, '', null, 'req-2', 'en')

    expect(analysis.isFallback).toBe(false)
    expect(completeThroughRelay.mock.calls[1][0].messages.at(-1).content).toMatch(/grammarAccuracy/)
  })

  it('falls back after a second bad reply, without a third call', async () => {
    completeThroughRelay.mockResolvedValue(reply('not json at all'))

    const analysis = await analyzeEssay(ESSAY, null, '', null, 'req-3', 'en')

    expect(analysis.isFallback).toBe(true)
    expect(completeThroughRelay).toHaveBeenCalledTimes(2)
  })

  it('does not retry provider errors (the gateway already failed over)', async () => {
    completeThroughRelay.mockRejectedValue(Object.assign(new Error('All providers failed'), { status: 503, code: 'AI_NOT_CONFIGURED' }))

    const analysis = await analyzeEssay(ESSAY, null, '', null, 'req-4', 'en')

    expect(analysis.isFallback).toBe(true)
    expect(completeThroughRelay).toHaveBeenCalledTimes(1)
  })
})

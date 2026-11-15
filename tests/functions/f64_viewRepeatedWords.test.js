import { vi, describe, it, expect, beforeEach } from 'vitest'
import { createMockContext } from './testHelper.js'

vi.mock('../../src/models/AIAnalysis.js', () => ({
  default: {
    findOne: vi.fn(),
  }
}))
vi.mock('../../src/models/Essay.js', () => ({
  default: { findById: vi.fn() }
}))

import AIAnalysis from '../../src/models/AIAnalysis.js'
import Essay from '../../src/models/Essay.js'
import { getAnalysis } from '../../src/controllers/analysis.controller.js'

describe('F64: View Repeated Words and Synonym Suggestions (getAnalysis)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    Essay.findById.mockResolvedValue({ _id: 'essay-test', student: 'student_1', content: 'Legacy essay content' })
  })

  it('UTCID01 (N): should return single repeated word with replacement suggestions', async () => {
    const mockAnalysis = {
      essay: 'essay_64_1',
      repeatedWords: [
        { word: 'important', count: 6, suggestions: ['crucial', 'vital', 'essential'] }
      ]
    }
    AIAnalysis.findOne.mockReturnValue({
      populate: vi.fn().mockResolvedValue(mockAnalysis)
    })

    const { req, res, next } = createMockContext({
      params: { essayId: 'essay_64_1' }
    })

    await getAnalysis(req, res, next)

    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.data.data.repeatedWords).toHaveLength(1)
    expect(res.data.data.repeatedWords[0].word).toBe('important')
    expect(res.data.data.repeatedWords[0].suggestions).toContain('crucial')
  })

  it('UTCID02 (N): should return multiple repeated words with tier suggestions', async () => {
    const mockAnalysis = {
      essay: 'essay_64_2',
      repeatedWords: [
        { word: 'good', count: 5, suggestions: ['advantageous', 'favorable', 'beneficial'] },
        { word: 'bad', count: 4, suggestions: ['adverse', 'detrimental', 'unfavorable'] }
      ]
    }
    AIAnalysis.findOne.mockReturnValue({
      populate: vi.fn().mockResolvedValue(mockAnalysis)
    })

    const { req, res, next } = createMockContext({
      params: { essayId: 'essay_64_2' }
    })

    await getAnalysis(req, res, next)

    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.data.data.repeatedWords).toHaveLength(2)
    expect(res.data.data.repeatedWords[0].word).toBe('good')
    expect(res.data.data.repeatedWords[1].word).toBe('bad')
  })

  it('UTCID03 (B): should return empty repeatedWords array when essay vocabulary is diverse without excessive repetition', async () => {
    const mockAnalysis = {
      essay: 'essay_64_3',
      repeatedWords: []
    }
    AIAnalysis.findOne.mockReturnValue({
      populate: vi.fn().mockResolvedValue(mockAnalysis)
    })

    const { req, res, next } = createMockContext({
      params: { essayId: 'essay_64_3' }
    })

    await getAnalysis(req, res, next)

    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.data.data.repeatedWords).toEqual([])
  })

  it('UTCID04 (A): should report processing when an existing essay has no analysis yet', async () => {
    AIAnalysis.findOne.mockReturnValue({
      populate: vi.fn().mockResolvedValue(null)
    })

    const { req, res, next } = createMockContext({
      params: { essayId: 'missing_analysis_id' }
    })

    await getAnalysis(req, res, next)

    expect(next).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.data.data).toBeNull()
    expect(res.data.gradingStatus).toBe('processing')
  })
})

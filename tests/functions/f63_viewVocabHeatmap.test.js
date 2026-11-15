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

describe('F63: View Vocabulary Errors and Heatmap (getAnalysis)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    Essay.findById.mockResolvedValue({ _id: 'essay-test', student: 'student_1', content: 'Legacy essay content' })
  })

  it('UTCID01 (N): should return vocabulary analysis and CEFR distribution', async () => {
    const mockAnalysis = {
      essay: 'essay_63_1',
      vocabularyAnalysis: {
        academicWords: ['significant', 'prevalent'],
        cefrDistribution: { A1: 20, B2: 50, C1: 30 }
      },
      advancedAnalytics: {
        heatmap: [{ sentence: 'Artificial intelligence is transformative.', score: 8.5 }]
      }
    }
    AIAnalysis.findOne.mockReturnValue({
      populate: vi.fn().mockResolvedValue(mockAnalysis)
    })

    const { req, res, next } = createMockContext({
      params: { essayId: 'essay_63_1' }
    })

    await getAnalysis(req, res, next)

    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.data.data.vocabularyAnalysis.academicWords).toContain('significant')
    expect(res.data.data.vocabularyAnalysis.cefrDistribution.C1).toBe(30)
  })

  it('UTCID02 (N): should return sentence heatmap array with multiple scores', async () => {
    const mockAnalysis = {
      essay: 'essay_63_2',
      advancedAnalytics: {
        heatmap: [
          { sentence: 'First sentence.', score: 7.0 },
          { sentence: 'Second sentence with sophisticated words.', score: 9.0 }
        ]
      }
    }
    AIAnalysis.findOne.mockReturnValue({
      populate: vi.fn().mockResolvedValue(mockAnalysis)
    })

    const { req, res, next } = createMockContext({
      params: { essayId: 'essay_63_2' }
    })

    await getAnalysis(req, res, next)

    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.data.data.advancedAnalytics.heatmap).toHaveLength(2)
    expect(res.data.data.advancedAnalytics.heatmap[1].score).toBe(9.0)
  })

  it('UTCID03 (B): should handle boundary case where vocabulary consists purely of basic A1 level words', async () => {
    const mockAnalysis = {
      essay: 'essay_63_3',
      vocabularyAnalysis: {
        academicWords: [],
        cefrDistribution: { A1: 100, A2: 0, B1: 0, B2: 0, C1: 0, C2: 0 }
      },
      advancedAnalytics: {
        heatmap: [{ sentence: 'I have a dog.', score: 4.0 }]
      }
    }
    AIAnalysis.findOne.mockReturnValue({
      populate: vi.fn().mockResolvedValue(mockAnalysis)
    })

    const { req, res, next } = createMockContext({
      params: { essayId: 'essay_63_3' }
    })

    await getAnalysis(req, res, next)

    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.data.data.vocabularyAnalysis.cefrDistribution.A1).toBe(100)
  })

  it('UTCID04 (A): should report processing when an existing essay has no analysis yet', async () => {
    AIAnalysis.findOne.mockReturnValue({
      populate: vi.fn().mockResolvedValue(null)
    })

    const { req, res, next } = createMockContext({
      params: { essayId: 'unreviewed_id' }
    })

    await getAnalysis(req, res, next)

    expect(next).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.data.data).toBeNull()
    expect(res.data.gradingStatus).toBe('processing')
  })
})

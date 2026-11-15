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

describe('F65: View Lexical Diversity (getAnalysis)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    Essay.findById.mockResolvedValue({ _id: 'essay-test', student: 'student_1', content: 'Legacy essay content' })
  })

  it('UTCID01 (N): should return moderate lexical diversity metrics (TTR: 0.68, MTLD: 75.2)', async () => {
    const mockAnalysis = {
      essay: 'essay_65_1',
      advancedAnalytics: {
        lexicalDiversity: {
          ttr: 0.68,
          mtld: 75.2,
          hdd: 0.78
        }
      }
    }
    AIAnalysis.findOne.mockReturnValue({
      populate: vi.fn().mockResolvedValue(mockAnalysis)
    })

    const { req, res, next } = createMockContext({
      params: { essayId: 'essay_65_1' }
    })

    await getAnalysis(req, res, next)

    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.data.data.advancedAnalytics.lexicalDiversity.ttr).toBe(0.68)
    expect(res.data.data.advancedAnalytics.lexicalDiversity.mtld).toBe(75.2)
  })

  it('UTCID02 (B): should handle boundary high TTR (1.0) on rich distinct text', async () => {
    const mockAnalysis = {
      essay: 'essay_65_2',
      advancedAnalytics: {
        lexicalDiversity: {
          ttr: 1.0,
          mtld: 120.0,
          hdd: 0.95
        }
      }
    }
    AIAnalysis.findOne.mockReturnValue({
      populate: vi.fn().mockResolvedValue(mockAnalysis)
    })

    const { req, res, next } = createMockContext({
      params: { essayId: 'essay_65_2' }
    })

    await getAnalysis(req, res, next)

    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.data.data.advancedAnalytics.lexicalDiversity.ttr).toBe(1.0)
  })

  it('UTCID03 (B): should handle boundary low TTR (0.35) on highly repetitive text', async () => {
    const mockAnalysis = {
      essay: 'essay_65_3',
      advancedAnalytics: {
        lexicalDiversity: {
          ttr: 0.35,
          mtld: 28.4,
          hdd: 0.42
        }
      }
    }
    AIAnalysis.findOne.mockReturnValue({
      populate: vi.fn().mockResolvedValue(mockAnalysis)
    })

    const { req, res, next } = createMockContext({
      params: { essayId: 'essay_65_3' }
    })

    await getAnalysis(req, res, next)

    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.data.data.advancedAnalytics.lexicalDiversity.ttr).toBe(0.35)
    expect(res.data.data.advancedAnalytics.lexicalDiversity.mtld).toBe(28.4)
  })

  it('UTCID04 (A): should report processing when an existing essay has no analysis yet', async () => {
    AIAnalysis.findOne.mockReturnValue({
      populate: vi.fn().mockResolvedValue(null)
    })

    const { req, res, next } = createMockContext({
      params: { essayId: 'non_existent_essay' }
    })

    await getAnalysis(req, res, next)

    expect(next).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.data.data).toBeNull()
    expect(res.data.gradingStatus).toBe('processing')
  })
})

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

describe('F62: View Grammar Errors (getAnalysis)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    Essay.findById.mockResolvedValue({ _id: 'essay-test', student: 'student_1', content: 'Legacy essay content' })
  })

  it('UTCID01 (N): should return grammar errors from analysis record', async () => {
    const mockAnalysis = {
      essay: 'essay_62_1',
      grammarErrors: [
        { error: 'was go', correction: 'went', explanation: 'Past tense required' }
      ]
    }
    AIAnalysis.findOne.mockReturnValue({
      populate: vi.fn().mockResolvedValue(mockAnalysis)
    })

    const { req, res, next } = createMockContext({
      params: { essayId: 'essay_62_1' }
    })

    await getAnalysis(req, res, next)

    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.data.success).toBe(true)
    expect(res.data.data.grammarErrors).toHaveLength(1)
    expect(res.data.data.grammarErrors[0].correction).toBe('went')
  })

  it('UTCID02 (N): should return multiple grammar errors across different sentences', async () => {
    const mockAnalysis = {
      essay: 'essay_62_2',
      grammarErrors: [
        { error: 'she like', correction: 'she likes', explanation: 'Subject-verb agreement' },
        { error: 'more better', correction: 'better', explanation: 'Double comparative error' }
      ]
    }
    AIAnalysis.findOne.mockReturnValue({
      populate: vi.fn().mockResolvedValue(mockAnalysis)
    })

    const { req, res, next } = createMockContext({
      params: { essayId: 'essay_62_2' }
    })

    await getAnalysis(req, res, next)

    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.data.data.grammarErrors).toHaveLength(2)
  })

  it('UTCID03 (B): should return empty array when essay has zero grammar errors', async () => {
    const mockAnalysis = {
      essay: 'essay_62_3',
      grammarErrors: []
    }
    AIAnalysis.findOne.mockReturnValue({
      populate: vi.fn().mockResolvedValue(mockAnalysis)
    })

    const { req, res, next } = createMockContext({
      params: { essayId: 'essay_62_3' }
    })

    await getAnalysis(req, res, next)

    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.data.data.grammarErrors).toEqual([])
  })

  it('UTCID04 (A): should report processing when an existing essay has no analysis yet', async () => {
    AIAnalysis.findOne.mockReturnValue({
      populate: vi.fn().mockResolvedValue(null)
    })

    const { req, res, next } = createMockContext({
      params: { essayId: 'non_analyzed_essay' }
    })

    await getAnalysis(req, res, next)

    expect(next).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.data.data).toBeNull()
    expect(res.data.gradingStatus).toBe('processing')
  })
})

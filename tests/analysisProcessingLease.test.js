import { vi, describe, it, expect, beforeEach } from 'vitest'
import { createMockContext } from './functions/testHelper.js'

vi.mock('../src/models/AIAnalysis.js', () => ({ default: { findOne: vi.fn() } }))
vi.mock('../src/models/Essay.js', () => ({ default: { findById: vi.fn(), updateOne: vi.fn() } }))

import AIAnalysis from '../src/models/AIAnalysis.js'
import Essay from '../src/models/Essay.js'
import { getAnalysis } from '../src/controllers/analysis.controller.js'

const processingEssay = (until) => ({
  _id: 'essay-lease', student: 'student_1', content: 'Essay text',
  revisionCounter: 2, aiAnalysisStatus: 'processing', aiAnalysisRevision: 2, aiAnalysisProcessingUntil: until,
})

describe('essay grading lease (getAnalysis)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    AIAnalysis.findOne.mockReturnValue({ populate: vi.fn().mockResolvedValue(null) })
    Essay.updateOne.mockResolvedValue({ modifiedCount: 1 })
  })

  it('keeps reporting processing while the lease is live', async () => {
    Essay.findById.mockResolvedValue(processingEssay(new Date(Date.now() + 60_000)))
    const { req, res, next } = createMockContext({ params: { essayId: 'essay-lease' } })

    await getAnalysis(req, res, next)

    expect(res.data.gradingStatus).toBe('processing')
    expect(Essay.updateOne).not.toHaveBeenCalled()
  })

  it('releases a grading whose lease expired and reports it as failed', async () => {
    const until = new Date(Date.now() - 1000)
    Essay.findById.mockResolvedValue(processingEssay(until))
    const { req, res, next } = createMockContext({ params: { essayId: 'essay-lease' } })

    await getAnalysis(req, res, next)

    expect(res.data).toMatchObject({ gradingStatus: 'failed', reason: 'AI_ANALYSIS_STALLED' })
    expect(Essay.updateOne).toHaveBeenCalledWith(
      { _id: 'essay-lease', aiAnalysisStatus: 'processing', aiAnalysisRevision: 2, aiAnalysisProcessingUntil: until },
      { $set: { aiAnalysisStatus: 'failed', aiAnalysisProcessingUntil: null } },
    )
  })

  it('treats a processing essay from before the lease existed as stalled', async () => {
    Essay.findById.mockResolvedValue(processingEssay(undefined))
    const { req, res, next } = createMockContext({ params: { essayId: 'essay-lease' } })

    await getAnalysis(req, res, next)

    expect(res.data.gradingStatus).toBe('failed')
  })
})

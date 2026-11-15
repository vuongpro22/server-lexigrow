import { beforeEach, describe, expect, it, vi } from 'vitest'
import ManualFeedback from '../src/models/ManualFeedback.js'
import Essay from '../src/models/Essay.js'
import AIAnalysis from '../src/models/AIAnalysis.js'
import Class from '../src/models/Class.js'
import { createFeedback, updateFeedback, submitFeedback } from '../src/controllers/feedback.controller.js'

vi.mock('../src/models/ManualFeedback.js', () => ({ default: { findOne: vi.fn(), create: vi.fn() } }))
vi.mock('../src/models/Essay.js', () => ({ default: { findById: vi.fn(), findByIdAndUpdate: vi.fn() } }))
vi.mock('../src/models/AIAnalysis.js', () => ({ default: Object.assign(vi.fn(), { findOne: vi.fn() }) }))
vi.mock('../src/models/Class.js', () => ({ default: { findOne: vi.fn() } }))
vi.mock('../src/services/notification.service.js', () => ({ createNotification: vi.fn().mockResolvedValue({}) }))

const scores = { grammar: 8, vocabulary: 8, coherence: 8, complexity: 8 }
const request = (body = {}) => ({ user: { _id: 'teacher', role: 'teacher' }, params: { essayId: 'essay', id: 'feedback' }, body })
const response = () => ({ status: vi.fn().mockReturnThis(), json: vi.fn() })

describe('draft feedback scores stay separate from published analysis', () => {
  let analysis
  beforeEach(() => {
    vi.clearAllMocks()
    analysis = { overallScore: 6, isTeacherGraded: false, scores: { grammarAccuracy: 6 }, save: vi.fn().mockResolvedValue() }
    AIAnalysis.findOne.mockResolvedValue(analysis)
    Class.findOne.mockReturnValue({
      select: vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue({ _id: 'class', status: 'active' }),
      }),
    })
    Essay.findById.mockResolvedValue({
      _id: 'essay',
      status: 'submitted',
      student: 'student',
      class: 'class',
      assignment: null,
    })
    Essay.findByIdAndUpdate.mockResolvedValue(null)
  })

  it('creates a draft with teacher scores without reading or changing analysis', async () => {
    ManualFeedback.findOne.mockResolvedValue(null)
    ManualFeedback.create.mockImplementation(async data => data)
    const res = response()
    const next = vi.fn()
    await createFeedback(request({ scores, feedbackText: 'Working draft' }), res, next)
    expect(next).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(201)
    expect(ManualFeedback.create).toHaveBeenCalledWith(expect.objectContaining({ scores, status: 'draft' }))
    expect(AIAnalysis.findOne).not.toHaveBeenCalled()
    expect(AIAnalysis).not.toHaveBeenCalled()
    expect(analysis.overallScore).toBe(6)
    expect(analysis.save).not.toHaveBeenCalled()
  })

  it('fills missing rubric criteria with the neutral default when creating a draft', async () => {
    ManualFeedback.findOne.mockResolvedValue(null)
    ManualFeedback.create.mockImplementation(async data => data)

    await createFeedback(request({ scores: { grammar: 8 } }), response(), vi.fn())

    expect(ManualFeedback.create).toHaveBeenCalledWith(expect.objectContaining({
      scores: { grammar: 8, vocabulary: 5, coherence: 5, complexity: 5 },
    }))
  })

  it('updates and retains draft scores without publishing them', async () => {
    const feedback = { essay: 'essay', status: 'draft', scores, save: vi.fn().mockResolvedValue() }
    ManualFeedback.findOne.mockResolvedValue(feedback)
    const next = vi.fn()
    await updateFeedback(request({ scores: { grammar: 7 }, feedbackText: 'Continue tomorrow' }), response(), next)
    expect(next).not.toHaveBeenCalled()
    expect(feedback.scores).toEqual({ ...scores, grammar: 7 })
    expect(feedback.feedbackText).toBe('Continue tomorrow')
    expect(feedback.save).toHaveBeenCalled()
    expect(AIAnalysis.findOne).not.toHaveBeenCalled()
    expect(analysis.overallScore).toBe(6)
    expect(analysis.isTeacherGraded).toBe(false)
    expect(Essay.findByIdAndUpdate).not.toHaveBeenCalled()
  })

  it('merges a Mongoose score subdocument without dropping the other criteria', async () => {
    const feedback = {
      essay: 'essay',
      status: 'draft',
      scores: { toObject: () => ({ grammar: 6, vocabulary: 7, coherence: 8, complexity: 9 }) },
      save: vi.fn().mockResolvedValue(),
    }
    ManualFeedback.findOne.mockResolvedValue(feedback)

    await updateFeedback(request({ scores: { grammar: 7 } }), response(), vi.fn())

    expect(feedback.scores).toEqual({ grammar: 7, vocabulary: 7, coherence: 8, complexity: 9 })
  })

  it('publishes the latest saved scores only on submit', async () => {
    const feedback = { essay: 'essay', status: 'draft', scores, save: vi.fn().mockResolvedValue() }
    ManualFeedback.findOne.mockResolvedValue(feedback)
    const next = vi.fn()
    await updateFeedback(request({ scores: { grammar: 7 } }), response(), next)
    expect(analysis.save).not.toHaveBeenCalled()
    await submitFeedback(request(), response(), next)
    expect(next).not.toHaveBeenCalled()
    expect(feedback.status).toBe('submitted')
    expect(analysis.overallScore).toBe(7.8)
    expect(analysis.scores.grammarAccuracy).toBe(7)
    expect(analysis.isTeacherGraded).toBe(true)
    expect(analysis.save).toHaveBeenCalledOnce()
    expect(Essay.findByIdAndUpdate).toHaveBeenCalledWith('essay', { status: 'reviewed' }, { new: true })
  })

  it('creates an analysis for an unanalysed essay only when submitted', async () => {
    AIAnalysis.findOne.mockResolvedValue(null)
    const save = vi.fn().mockResolvedValue()
    AIAnalysis.mockImplementation(function (data) { Object.assign(this, data, { save }) })
    const feedback = { essay: 'essay', status: 'draft', scores, save: vi.fn().mockResolvedValue() }
    ManualFeedback.findOne.mockResolvedValue(feedback)
    const next = vi.fn()
    await updateFeedback(request({ scores }), response(), next)
    expect(AIAnalysis).not.toHaveBeenCalled()
    await submitFeedback(request(), response(), next)
    expect(next).not.toHaveBeenCalled()
    expect(AIAnalysis).toHaveBeenCalledWith(expect.objectContaining({ essay: 'essay', overallScore: 8, isTeacherGraded: true }))
    expect(save).toHaveBeenCalledOnce()
  })

  it('does not treat a missing rubric criterion as zero when submitting', async () => {
    AIAnalysis.findOne.mockResolvedValue(null)
    const save = vi.fn().mockResolvedValue()
    AIAnalysis.mockImplementation(function (data) { Object.assign(this, data, { save }) })
    const feedback = {
      essay: 'essay',
      status: 'draft',
      scores: { grammar: 8 },
      save: vi.fn().mockResolvedValue(),
    }
    ManualFeedback.findOne.mockResolvedValue(feedback)

    await submitFeedback(request(), response(), vi.fn())

    expect(AIAnalysis).toHaveBeenCalledWith(expect.objectContaining({
      overallScore: 5.8,
      scores: expect.objectContaining({
        grammarAccuracy: 8,
        coherence: 5,
        complexityIndex: 5,
        lexicalResource: 5,
      }),
    }))
  })
})

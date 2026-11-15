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

const request = (body = {}) => ({
  user: { _id: 'teacher1', role: 'teacher', name: 'Teacher One' },
  params: { essayId: 'essay1', id: 'feedback1' },
  body,
})
const response = () => ({ status: vi.fn().mockReturnThis(), json: vi.fn() })

function classQuery(status) {
  return {
    select: vi.fn().mockReturnValue({
      lean: vi.fn().mockResolvedValue(status ? { _id: 'class1', status } : null),
    }),
  }
}

async function run(handler, req) {
  const next = vi.fn()
  await handler(req, response(), next)
  return next
}

describe('TEACH-01 teacher feedback object-level authorization', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    Class.findOne.mockReturnValue(classQuery(null))
    AIAnalysis.findOne.mockResolvedValue(null)
    Essay.findById.mockResolvedValue({
      _id: 'essay1',
      status: 'submitted',
      student: 'student1',
      class: 'class1',
      assignment: null,
    })
  })

  it('rejects feedback for an essay outside the teacher classes', async () => {
    const next = await run(createFeedback, request({ scores: { grammar: 8 } }))
    expect(ManualFeedback.create).not.toHaveBeenCalled()
    expect(next).toHaveBeenCalledOnce()
    expect(next.mock.calls[0][0].statusCode).toBe(403)
  })

  it('allows the teacher of the essay class', async () => {
    Class.findOne.mockReturnValue(classQuery('active'))
    ManualFeedback.findOne.mockResolvedValue(null)
    ManualFeedback.create.mockImplementation(async data => data)
    const res = response()
    const next = vi.fn()

    await createFeedback(request({ scores: { grammar: 8 } }), res, next)

    expect(next).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(201)
    expect(Class.findOne).toHaveBeenCalledWith({
      _id: 'class1',
      teacher: 'teacher1',
      students: 'student1',
    })
  })

  it('does not allow assignment ownership to bypass the essay class', async () => {
    Essay.findById.mockResolvedValue({
      _id: 'essay1',
      status: 'submitted',
      student: 'student1',
      class: 'classNew',
      assignment: 'assignment1',
    })
    Class.findOne.mockReturnValue(classQuery(null))

    const next = await run(createFeedback, request({ scores: { grammar: 8 } }))

    expect(next).toHaveBeenCalledOnce()
    expect(next.mock.calls[0][0].statusCode).toBe(403)
    expect(ManualFeedback.create).not.toHaveBeenCalled()
  })

  it('rejects grading an archived class even when the essay belongs to it', async () => {
    Class.findOne.mockReturnValue(classQuery('archived'))
    const next = await run(createFeedback, request({ scores: { grammar: 8 } }))

    expect(next).toHaveBeenCalledOnce()
    expect(next.mock.calls[0][0].statusCode).toBe(409)
    expect(next.mock.calls[0][0].code).toBe('CLASS_NOT_ACTIVE')
  })

  it('rejects grading a draft essay even when the teacher owns the class', async () => {
    Class.findOne.mockReturnValue(classQuery('active'))
    Essay.findById.mockResolvedValue({
      _id: 'essay1',
      status: 'draft',
      student: 'student1',
      class: 'class1',
      assignment: null,
    })
    const next = await run(createFeedback, request({ scores: { grammar: 8 } }))
    expect(next).toHaveBeenCalledOnce()
    expect(next.mock.calls[0][0].statusCode).toBe(409)
    expect(next.mock.calls[0][0].code).toBe('ESSAY_NOT_SUBMITTED')
    expect(ManualFeedback.create).not.toHaveBeenCalled()
  })

  it('rejects updating feedback when the essay is no longer in the teacher class', async () => {
    const feedback = { essay: 'essay1', status: 'draft', scores: {}, save: vi.fn() }
    ManualFeedback.findOne.mockResolvedValue(feedback)
    const next = await run(updateFeedback, request({ feedbackText: 'Retargeted' }))
    expect(next).toHaveBeenCalledOnce()
    expect(next.mock.calls[0][0].statusCode).toBe(403)
    expect(feedback.save).not.toHaveBeenCalled()
  })

  it('rejects updating feedback on a draft essay', async () => {
    ManualFeedback.findOne.mockResolvedValue({ essay: 'essay1', status: 'draft', scores: {}, save: vi.fn() })
    Class.findOne.mockReturnValue(classQuery('active'))
    Essay.findById.mockResolvedValue({ _id: 'essay1', status: 'draft', student: 'student1', class: 'class1', assignment: null })
    const next = await run(updateFeedback, request({ feedbackText: 'Draft notes' }))
    expect(next).toHaveBeenCalledOnce()
    expect(next.mock.calls[0][0].statusCode).toBe(409)
  })

  it('rejects submitting feedback when the essay is outside the teacher class', async () => {
    const feedback = { essay: 'essay1', status: 'draft', scores: {}, save: vi.fn() }
    ManualFeedback.findOne.mockResolvedValue(feedback)
    const next = await run(submitFeedback, request())
    expect(next).toHaveBeenCalledOnce()
    expect(next.mock.calls[0][0].statusCode).toBe(403)
    expect(feedback.status).toBe('draft')
    expect(feedback.save).not.toHaveBeenCalled()
  })
})

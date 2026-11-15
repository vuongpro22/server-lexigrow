import { beforeEach, describe, expect, it, vi } from 'vitest'
import ManualFeedback from '../src/models/ManualFeedback.js'
import Essay from '../src/models/Essay.js'
import { canAccessEssay } from '../src/utils/essayAccess.js'
import { getFeedbackByEssay } from '../src/controllers/feedback.controller.js'

vi.mock('../src/models/ManualFeedback.js', () => ({ default: { findOne: vi.fn(), create: vi.fn() } }))
vi.mock('../src/models/Essay.js', () => ({ default: { findById: vi.fn(), findByIdAndUpdate: vi.fn() } }))
vi.mock('../src/models/AIAnalysis.js', () => ({ default: Object.assign(vi.fn(), { findOne: vi.fn() }) }))
vi.mock('../src/models/Assignment.js', () => ({ default: { exists: vi.fn() } }))
vi.mock('../src/utils/essayAccess.js', () => ({ canAccessEssay: vi.fn() }))

const request = role => ({
  user: { _id: role === 'teacher' ? 'teacher1' : role === 'admin' ? 'admin1' : 'reader1', role },
  params: { essayId: 'essay1' },
})
const response = () => ({ status: vi.fn().mockReturnThis(), json: vi.fn() })

function feedbackQuery(value) {
  return { populate: vi.fn().mockResolvedValue(value) }
}

describe('TEACH-04 draft feedback visibility', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    canAccessEssay.mockResolvedValue(true)
    Essay.findById.mockReturnValue({
      select: vi.fn().mockResolvedValue({ _id: 'essay1', student: 'student1' }),
    })
  })

  it('shows students only submitted feedback', async () => {
    ManualFeedback.findOne.mockReturnValue(feedbackQuery(null))
    const res = response()

    await getFeedbackByEssay(request('student'), res, vi.fn())

    expect(ManualFeedback.findOne).toHaveBeenCalledWith({ essay: 'essay1', status: 'submitted' })
    expect(res.json).toHaveBeenCalledWith({ success: true, data: null })
  })

  it('shows parents only submitted feedback', async () => {
    ManualFeedback.findOne.mockReturnValue(feedbackQuery(null))

    await getFeedbackByEssay(request('parent'), response(), vi.fn())

    expect(ManualFeedback.findOne).toHaveBeenCalledWith({ essay: 'essay1', status: 'submitted' })
  })

  it('lets the grading teacher read their own draft', async () => {
    ManualFeedback.findOne.mockReturnValue(feedbackQuery({ _id: 'feedback1', status: 'draft' }))

    await getFeedbackByEssay(request('teacher'), response(), vi.fn())

    expect(ManualFeedback.findOne).toHaveBeenCalledWith({ essay: 'essay1', teacher: 'teacher1' })
  })

  it('lets an admin read any feedback regardless of status', async () => {
    ManualFeedback.findOne.mockReturnValue(feedbackQuery({ _id: 'feedback1', status: 'draft' }))

    await getFeedbackByEssay(request('admin'), response(), vi.fn())

    expect(ManualFeedback.findOne).toHaveBeenCalledWith({ essay: 'essay1' })
  })
})

import { beforeEach, describe, expect, it, vi } from 'vitest'
import ParentStudentLink from '../src/models/ParentStudentLink.js'
import Vocabulary from '../src/models/Vocabulary.js'
import Essay from '../src/models/Essay.js'
import AIAnalysis from '../src/models/AIAnalysis.js'
import { getOverview } from '../src/controllers/progress.controller.js'

vi.mock('../src/models/ParentStudentLink.js', () => ({ default: { findOne: vi.fn() } }))
vi.mock('../src/models/Vocabulary.js', () => ({ default: { countDocuments: vi.fn() } }))
vi.mock('../src/models/Essay.js', () => ({ default: { find: vi.fn(), countDocuments: vi.fn() } }))
vi.mock('../src/models/AIAnalysis.js', () => ({ default: { find: vi.fn() } }))
vi.mock('../src/models/User.js', () => ({ default: { findById: vi.fn() } }))
vi.mock('../src/models/Class.js', () => ({ default: { find: vi.fn() } }))
vi.mock('../src/models/ReviewEvent.js', () => ({ default: { find: vi.fn() } }))
vi.mock('../src/models/DailyQuest.js', () => ({ default: { find: vi.fn() } }))

const request = () => ({
  user: { _id: 'parent1', role: 'parent' },
  query: { studentId: 'student1' },
})
const response = () => ({ status: vi.fn().mockReturnThis(), json: vi.fn() })

describe('PARENT-01 progress access uses ParentStudentLink', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    Vocabulary.countDocuments.mockResolvedValue(0)
    Essay.find.mockReturnValue({ distinct: vi.fn().mockResolvedValue([]) })
    Essay.countDocuments.mockResolvedValue(0)
    AIAnalysis.find.mockResolvedValue([])
  })

  it('denies progress when the active link has been revoked', async () => {
    ParentStudentLink.findOne.mockResolvedValue(null)
    const next = vi.fn()

    await getOverview(request(), response(), next)

    expect(ParentStudentLink.findOne).toHaveBeenCalledWith({
      parent: 'parent1',
      student: 'student1',
      status: 'active',
    })
    expect(next).toHaveBeenCalledOnce()
    expect(next.mock.calls[0][0].statusCode).toBe(403)
    expect(Vocabulary.countDocuments).not.toHaveBeenCalled()
  })

  it('allows progress while the link is active', async () => {
    ParentStudentLink.findOne.mockResolvedValue({ _id: 'link1', status: 'active' })
    const res = response()
    const next = vi.fn()

    await getOverview(request(), res, next)

    expect(next).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }))
  })
})

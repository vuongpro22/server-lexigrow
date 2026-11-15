import { beforeEach, describe, expect, it, vi } from 'vitest'
import Class from '../src/models/Class.js'
import Assignment from '../src/models/Assignment.js'
import Essay from '../src/models/Essay.js'
import ManualFeedback from '../src/models/ManualFeedback.js'
import { getPendingEssays } from '../src/controllers/feedback.controller.js'

vi.mock('../src/models/Class.js', () => ({ default: { find: vi.fn() } }))
vi.mock('../src/models/Assignment.js', () => ({ default: { distinct: vi.fn() } }))
vi.mock('../src/models/Essay.js', () => ({ default: { find: vi.fn() } }))
vi.mock('../src/models/ManualFeedback.js', () => ({ default: { find: vi.fn() } }))

const request = () => ({ user: { _id: 'teacher1', role: 'teacher' } })
const response = () => ({ status: vi.fn().mockReturnThis(), json: vi.fn() })

function classQuery(classes) {
  return {
    select: vi.fn().mockReturnValue({
      lean: vi.fn().mockResolvedValue(classes),
    }),
  }
}

function distinctQuery(ids) {
  return { distinct: vi.fn().mockResolvedValue(ids) }
}

function essayQuery(rows) {
  const query = {
    populate: vi.fn().mockImplementation(() => query),
    sort: vi.fn().mockResolvedValue(rows),
  }
  return query
}

describe('TEACH-11 pending essay queue', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    Class.find.mockReturnValue(classQuery([
      { _id: 'class1', students: ['student1'] },
    ]))
    Assignment.distinct.mockResolvedValue(['assignment1'])
  })

  it('keeps an essay in the queue when the teacher only saved a draft', async () => {
    ManualFeedback.find.mockReturnValue(distinctQuery([]))
    Essay.find.mockReturnValue(essayQuery([{ _id: 'essay1', status: 'submitted' }]))
    const res = response()

    await getPendingEssays(request(), res, vi.fn())

    expect(ManualFeedback.find).toHaveBeenCalledWith({
      teacher: 'teacher1',
      status: 'submitted',
    })
    expect(Class.find).toHaveBeenCalledWith({
      teacher: 'teacher1',
      status: { $in: ['active', 'archived'] },
    })
    expect(Essay.find).toHaveBeenCalledWith({
      student: { $in: ['student1'] },
      status: { $in: ['submitted', 'reviewed'] },
      _id: { $nin: [] },
      $or: [
        { class: { $in: ['class1'] } },
        { assignment: { $in: ['assignment1'] } },
      ],
    })
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      count: 1,
      data: [{ _id: 'essay1', status: 'submitted' }],
    })
  })

  it('removes an essay only after feedback has been submitted', async () => {
    ManualFeedback.find.mockReturnValue(distinctQuery(['essay1']))
    Essay.find.mockReturnValue(essayQuery([]))

    await getPendingEssays(request(), response(), vi.fn())

    expect(Essay.find).toHaveBeenCalledWith(expect.objectContaining({
      _id: { $nin: ['essay1'] },
    }))
  })
})

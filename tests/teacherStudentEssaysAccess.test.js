import { beforeEach, describe, expect, it, vi } from 'vitest'
import Class from '../src/models/Class.js'
import Assignment from '../src/models/Assignment.js'
import Essay from '../src/models/Essay.js'
import { getStudentEssays } from '../src/controllers/teacher.controller.js'

vi.mock('../src/models/Class.js', () => ({ default: { find: vi.fn() } }))
vi.mock('../src/models/Assignment.js', () => ({ default: { distinct: vi.fn() } }))
vi.mock('../src/models/Essay.js', () => ({ default: { find: vi.fn(), countDocuments: vi.fn() } }))

const request = (query = {}) => ({
  user: { _id: 'teacher1', role: 'teacher' },
  params: { id: 'student1' },
  query,
})
const response = () => ({ status: vi.fn().mockReturnThis(), json: vi.fn() })

function essayQuery(rows) {
  const query = {
    sort: vi.fn().mockImplementation(() => query),
    skip: vi.fn().mockImplementation(() => query),
    limit: vi.fn().mockResolvedValue(rows),
  }
  return query
}

function classesQuery(classes) {
  return {
    select: vi.fn().mockReturnValue({
      lean: vi.fn().mockResolvedValue(classes),
    }),
  }
}

describe('TEACH-03 teacher student essay access', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('denies a teacher who has no class containing the student', async () => {
    Class.find.mockReturnValue(classesQuery([]))
    const next = vi.fn()

    await getStudentEssays(request(), response(), next)

    expect(Class.find).toHaveBeenCalledWith({
      teacher: 'teacher1',
      students: 'student1',
      status: { $in: ['active', 'archived'] },
    })
    expect(Essay.find).not.toHaveBeenCalled()
    expect(next).toHaveBeenCalledOnce()
    expect(next.mock.calls[0][0].statusCode).toBe(403)
  })

  it('scopes essays to the teacher archived class, not another class of the same student', async () => {
    Class.find.mockReturnValue(classesQuery([{ _id: 'classOld' }]))
    Assignment.distinct.mockResolvedValue(['assignmentOld'])

    const allEssays = [
      { _id: 'essayOld', class: 'classOld' },
      { _id: 'essayNew', class: 'classNew' },
    ]
    Essay.find.mockImplementation(filter => {
      const classIds = filter.$or[0].class.$in
      return essayQuery(allEssays.filter(essay => classIds.includes(essay.class)))
    })
    Essay.countDocuments.mockResolvedValue(1)
    const res = response()
    const next = vi.fn()

    await getStudentEssays(request({ page: '2', limit: '10' }), res, next)

    expect(next).not.toHaveBeenCalled()
    expect(Assignment.distinct).toHaveBeenCalledWith('_id', {
      classId: { $in: ['classOld'] },
    })
    expect(Essay.find).toHaveBeenCalledWith({
      student: 'student1',
      status: { $ne: 'draft' },
      $or: [
        { class: { $in: ['classOld'] } },
        { assignment: { $in: ['assignmentOld'] } },
      ],
    })
    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      count: 1,
      total: 1,
      page: 2,
      data: [{ _id: 'essayOld', class: 'classOld' }],
    })
  })
})

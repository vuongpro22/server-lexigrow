import { beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'

vi.mock('../src/config/db.js', () => ({
  default: vi.fn().mockResolvedValue()
}))

vi.mock('../src/models/Assignment.js', () => ({
  default: {
    create: vi.fn(),
    findById: vi.fn()
  }
}))

vi.mock('../src/models/Class.js', () => ({
  default: {
    findById: vi.fn(),
    findOne: vi.fn()
  }
}))

vi.mock('../src/models/Essay.js', () => ({
  default: {
    updateMany: vi.fn(),
    find: vi.fn()
  }
}))

vi.mock('../src/models/LearningSession.js', () => ({
  default: {
    updateMany: vi.fn()
  }
}))

vi.mock('../src/services/notification.service.js', () => ({
  createManyNotifications: vi.fn().mockResolvedValue([]),
  createNotification: vi.fn().mockResolvedValue({})
}))

vi.mock('../src/middleware/auth.middleware.js', () => ({
  optionalAuth: (req, res, next) => next(),
  protect: (req, res, next) => {
    req.user = { _id: 'teacher_id', role: 'teacher', name: 'Test Teacher' }
    next()
  },
  authorize: (...roles) => (req, res, next) => {
    if (roles.includes(req.user.role)) return next()
    return res.status(403).json({ success: false, error: 'Forbidden' })
  }
}))

import app from '../src/index.js'
import Assignment from '../src/models/Assignment.js'
import Class from '../src/models/Class.js'
import Essay from '../src/models/Essay.js'
import LearningSession from '../src/models/LearningSession.js'

function classAccessQuery(status = 'active') {
  return {
    select: vi.fn().mockReturnValue({
      lean: vi.fn().mockResolvedValue({ _id: 'class_id', status }),
    }),
  }
}

describe('Assignment due date validation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it.each([
    ['a past date', '2020-01-01T00:00:00.000Z'],
    ['an invalid date', 'not-a-date']
  ])('rejects %s when creating an assignment', async (_label, dueDate) => {
    const res = await request(app)
      .post('/api/assignments')
      .send({
        title: 'Invalid deadline',
        dueDate,
        classId: 'class_id'
      })
      .expect(400)

    expect(res.body.success).toBe(false)
    expect(Assignment.create).not.toHaveBeenCalled()
  })

  it('rejects moving an existing assignment deadline into the past', async () => {
    Assignment.findById.mockResolvedValue({
      classId: 'class_id',
      teacher: { toString: () => 'teacher_id' },
      save: vi.fn()
    })
    Class.findOne.mockReturnValue(classAccessQuery('active'))

    const res = await request(app)
      .put('/api/assignments/assignment_id')
      .send({ dueDate: '2020-01-01T00:00:00.000Z' })
      .expect(400)

    expect(res.body.error).toContain('tương lai')
  })

  it('rejects creating an assignment for an archived class', async () => {
    Class.findById.mockResolvedValue({
      _id: 'class_id',
      teacher: { toString: () => 'teacher_id' },
      status: 'archived'
    })

    const res = await request(app)
      .post('/api/assignments')
      .send({
        title: 'Archived class task',
        dueDate: '2030-01-01T00:00:00.000Z',
        classId: 'class_id'
      })
      .expect(400)

    expect(res.body.success).toBe(false)
    expect(res.body.error).toContain('đã lưu trữ')
    expect(Assignment.create).not.toHaveBeenCalled()
  })

  it('allows editing an overdue assignment when its due date is unchanged', async () => {
    const overdueDueDate = new Date('2020-01-01T00:00:00.000Z')
    const save = vi.fn().mockResolvedValue(true)
    Assignment.findById.mockResolvedValue({
      _id: 'assignment_id',
      title: 'Old title',
      classId: 'class_id',
      dueDate: overdueDueDate,
      teacher: { toString: () => 'teacher_id' },
      save,
    })
    Class.findOne.mockReturnValue(classAccessQuery('active'))

    const res = await request(app)
      .put('/api/assignments/assignment_id')
      .send({
        title: 'Updated title',
        dueDate: overdueDueDate.toISOString(),
      })
      .expect(200)

    expect(res.body.success).toBe(true)
    expect(save).toHaveBeenCalledOnce()
  })

  it('keeps a newly created assignment closed when requested', async () => {
    Class.findById.mockResolvedValue({
      _id: 'class_id',
      teacher: { toString: () => 'teacher_id' },
      status: 'active',
      students: [],
    })
    Assignment.create.mockResolvedValue({ _id: 'new', status: 'closed' })

    const res = await request(app)
      .post('/api/assignments')
      .send({
        title: 'Closed task',
        dueDate: '2030-01-01T00:00:00.000Z',
        classId: 'class_id',
        status: 'closed',
      })
      .expect(201)

    expect(res.body.success).toBe(true)
    expect(Assignment.create).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Closed task',
      status: 'closed',
    }))
  })

  it('rejects an unsupported assignment status on create', async () => {
    Class.findById.mockResolvedValue({
      _id: 'class_id',
      teacher: { toString: () => 'teacher_id' },
      status: 'active',
      students: [],
    })

    const res = await request(app)
      .post('/api/assignments')
      .send({
        title: 'Invalid status task',
        dueDate: '2030-01-01T00:00:00.000Z',
        classId: 'class_id',
        status: 'archived',
      })
      .expect(400)

    expect(res.body.success).toBe(false)
    expect(Assignment.create).not.toHaveBeenCalled()
  })

  it('detaches essays and learning sessions before deleting an assignment', async () => {
    const deleteOne = vi.fn().mockResolvedValue(undefined)
    Assignment.findById.mockResolvedValue({
      _id: 'assignment_id',
      classId: 'class_id',
      teacher: { toString: () => 'teacher_id' },
      deleteOne,
    })
    Class.findOne.mockReturnValue(classAccessQuery('active'))
    Essay.updateMany.mockResolvedValue({ modifiedCount: 2 })
    LearningSession.updateMany.mockResolvedValue({ modifiedCount: 1 })

    await request(app)
      .delete('/api/assignments/assignment_id')
      .expect(200)

    expect(Essay.updateMany).toHaveBeenCalledWith(
      { assignment: 'assignment_id' },
      { $set: { assignment: null } },
    )
    expect(LearningSession.updateMany).toHaveBeenCalledWith(
      { assignment: 'assignment_id' },
      { $set: { assignment: null } },
    )
    expect(deleteOne).toHaveBeenCalledOnce()
  })

  it('prevents the old assignment owner from reading submissions after a class transfer', async () => {
    Assignment.findById.mockResolvedValue({
      _id: 'assignment_id',
      classId: 'class_id',
      teacher: { toString: () => 'teacher_id' },
    })
    Class.findOne.mockReturnValue({
      select: vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue(null),
      }),
    })

    const res = await request(app)
      .get('/api/assignments/assignment_id/submissions')
      .expect(403)

    expect(res.body.success).toBe(false)
    expect(Essay.find).not.toHaveBeenCalled()
  })
})
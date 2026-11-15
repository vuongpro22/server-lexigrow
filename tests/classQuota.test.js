import { beforeEach, describe, expect, it, vi } from 'vitest'
import Class from '../src/models/Class.js'
import Subscription from '../src/models/Subscription.js'
import SubscriptionPlan from '../src/models/SubscriptionPlan.js'
import Assignment from '../src/models/Assignment.js'
import Essay from '../src/models/Essay.js'
import Alert from '../src/models/Alert.js'
import { assertClassCapacity } from '../src/services/classQuota.service.js'
import { createClass, updateClass, deleteClass } from '../src/controllers/class.controller.js'

vi.mock('../src/models/Class.js', () => ({ default: {
  countDocuments: vi.fn(), findOne: vi.fn(), create: vi.fn(), findById: vi.fn(),
} }))
vi.mock('../src/models/Subscription.js', () => ({ default: { findOne: vi.fn() } }))
vi.mock('../src/models/SubscriptionPlan.js', () => ({ default: { findOne: vi.fn() } }))
vi.mock('../src/models/Assignment.js', () => ({ default: { countDocuments: vi.fn(), updateMany: vi.fn() } }))
vi.mock('../src/models/Essay.js', () => ({ default: { countDocuments: vi.fn(), updateMany: vi.fn() } }))
vi.mock('../src/models/Alert.js', () => ({ default: { countDocuments: vi.fn(), updateMany: vi.fn() } }))
vi.mock('../src/models/TeacherQuotaLock.js', () => ({ default: {
  findOneAndUpdate: vi.fn().mockResolvedValue({}), create: vi.fn(),
} }))
vi.mock('../src/utils/auditLogger.js', () => ({ logAction: vi.fn() }))

const req = (body = {}) => ({ user: { _id: 'teacher' }, params: { id: 'class' }, body })
const response = () => ({ status: vi.fn().mockReturnThis(), json: vi.fn() })

describe('teacher active class quota', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    Subscription.findOne.mockReturnValue({ sort: vi.fn().mockResolvedValue({ plan: 'paid-plan' }) })
    SubscriptionPlan.findOne.mockResolvedValue({ maxClasses: 3 })
    Class.countDocuments.mockResolvedValue(3)
  })

  it('rejects class creation at the paid limit before writing', async () => {
    const next = vi.fn()
    await createClass(req({ name: 'Extra' }), response(), next)
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 403 }))
    expect(Class.create).not.toHaveBeenCalled()
    expect(Class.countDocuments).toHaveBeenCalledWith({ teacher: 'teacher', status: { $ne: 'archived' } })
  })

  it('creates a class below the limit', async () => {
    Class.countDocuments.mockResolvedValue(2)
    Class.findOne.mockResolvedValue(null)
    Class.create.mockResolvedValue({ _id: 'new' })
    const res = response()
    const next = vi.fn()
    await createClass(req({ name: 'Allowed' }), res, next)
    expect(res.status).toHaveBeenCalledWith(201)
    expect(next).not.toHaveBeenCalled()
  })

  it.each(['archived', 'draft'])('rejects activation of a %s class when full', async (status) => {
    const cls = { _id: 'class', teacher: 'teacher', status, save: vi.fn() }
    Class.findById.mockResolvedValue(cls)
    const next = vi.fn()
    await updateClass(req({ status: 'active' }), response(), next)
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 403 }))
    expect(cls.save).not.toHaveBeenCalled()
    expect(cls.status).toBe(status)
    expect(Class.countDocuments).toHaveBeenCalledWith({
      teacher: 'teacher',
      status: { $ne: 'archived' },
      _id: { $ne: 'class' },
    })
  })

  it.each(['active', 'archived'])('allows an existing active class to be saved as %s while over quota', async (status) => {
    const cls = { _id: 'class', teacher: 'teacher', status: 'active', save: vi.fn() }
    Class.findById.mockResolvedValue(cls)
    await updateClass(req({ name: 'Renamed', status }), response(), vi.fn())
    expect(cls.save).toHaveBeenCalled()
    expect(Class.countDocuments).not.toHaveBeenCalled()
  })

  it('allows reactivation when a slot is available', async () => {
    Class.countDocuments.mockResolvedValue(2)
    const cls = { _id: 'class', teacher: 'teacher', status: 'archived', students: [], save: vi.fn() }
    Class.findById.mockResolvedValue(cls)
    await updateClass(req({ status: 'active' }), response(), vi.fn())
    expect(cls.save).toHaveBeenCalled()
    expect(cls.status).toBe('active')
  })

  it('uses one free slot without a current subscription', async () => {
    Subscription.findOne.mockReturnValue({ sort: vi.fn().mockResolvedValue(null) })
    Class.countDocuments.mockResolvedValue(0)
    await expect(assertClassCapacity('teacher')).resolves.toBeUndefined()
    Class.countDocuments.mockResolvedValue(1)
    await expect(assertClassCapacity('teacher')).rejects.toMatchObject({ statusCode: 403 })
    expect(SubscriptionPlan.findOne).not.toHaveBeenCalled()
    expect(Subscription.findOne).toHaveBeenCalledWith(expect.objectContaining({
      targetRole: 'teacher', status: 'active',
      startDate: { $lte: expect.any(Date) }, endDate: { $gte: expect.any(Date) },
    }))
  })

  it('respects a configured zero-class limit', async () => {
    SubscriptionPlan.findOne.mockResolvedValue({ maxClasses: 0 })
    Class.countDocuments.mockResolvedValue(0)
    await expect(assertClassCapacity('teacher')).rejects.toMatchObject({ statusCode: 403 })
  })

  it('detaches references after deleting a class without history', async () => {
    const deleteOne = vi.fn().mockResolvedValue(undefined)
    Class.findById.mockResolvedValue({ _id: 'class', teacher: 'teacher', deleteOne })
    Assignment.countDocuments.mockResolvedValue(0)
    Essay.countDocuments.mockResolvedValue(0)
    Alert.countDocuments.mockResolvedValue(0)
    Assignment.updateMany.mockResolvedValue({ modifiedCount: 0 })
    Essay.updateMany.mockResolvedValue({ modifiedCount: 0 })
    Alert.updateMany.mockResolvedValue({ modifiedCount: 0 })

    await deleteClass(req(), response(), vi.fn())

    expect(deleteOne).toHaveBeenCalledOnce()
    expect(Essay.updateMany).toHaveBeenCalledWith(
      { class: 'class' },
      { $set: { class: null } },
    )
    expect(Assignment.updateMany).toHaveBeenCalledWith(
      { classId: 'class' },
      { $set: { classId: null } },
    )
    expect(Alert.updateMany).toHaveBeenCalledWith(
      { class: 'class' },
      { $set: { class: null } },
    )
  })
})

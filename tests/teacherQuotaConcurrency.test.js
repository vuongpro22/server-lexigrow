import { beforeEach, describe, expect, it, vi } from 'vitest'
import Class from '../src/models/Class.js'
import User from '../src/models/User.js'
import Subscription from '../src/models/Subscription.js'
import SubscriptionPlan from '../src/models/SubscriptionPlan.js'
import TeacherQuotaLock from '../src/models/TeacherQuotaLock.js'
import { createClass, addStudent, updateClassByAdmin, restoreClassByAdmin } from '../src/controllers/class.controller.js'

vi.mock('../src/models/Class.js', () => ({ default: {
  countDocuments: vi.fn(), findOne: vi.fn(), create: vi.fn(), findById: vi.fn(), distinct: vi.fn(),
} }))
vi.mock('../src/models/User.js', () => ({ default: { findOne: vi.fn() } }))
vi.mock('../src/models/Subscription.js', () => ({ default: { findOne: vi.fn() } }))
vi.mock('../src/models/SubscriptionPlan.js', () => ({ default: { findOne: vi.fn() } }))
vi.mock('../src/models/TeacherQuotaLock.js', () => ({ default: {
  findOneAndUpdate: vi.fn(), create: vi.fn(),
} }))
vi.mock('../src/utils/auditLogger.js', () => ({ logAction: vi.fn() }))
vi.mock('../src/services/notification.service.js', () => ({ createNotification: vi.fn() }))

const lockRows = new Map()
const classRows = new Map()
let nextClassId = 0
let failNextSave = false

function makeClassDocument(row) {
  return {
    ...row,
    students: [...row.students],
    pendingStudents: [...row.pendingStudents],
    async save() {
      if (failNextSave) {
        failNextSave = false
        throw new Error('simulated class write failure')
      }
      row.students = [...this.students]
      row.pendingStudents = [...this.pendingStudents]
      row.status = this.status
      row.teacher = this.teacher
      return this
    },
  }
}

function installLockStore() {
  TeacherQuotaLock.findOneAndUpdate.mockImplementation(async (filter, update) => {
    const row = lockRows.get(String(filter._id))
    if (!row) return null
    if (filter.owner) {
      if (row.owner !== filter.owner) return null
      Object.assign(row, update.$set)
      return { ...row }
    }
    const expiry = filter.$or?.[0]?.leaseUntil?.$lte
    if (expiry && row.leaseUntil <= expiry) {
      Object.assign(row, update.$set)
      return { ...row }
    }
    return null
  })
  TeacherQuotaLock.create.mockImplementation(async values => {
    const key = String(values._id)
    if (lockRows.has(key)) throw Object.assign(new Error('duplicate key'), { code: 11000 })
    const row = { ...values }
    lockRows.set(key, row)
    return row
  })
}

const response = () => ({ status: vi.fn().mockReturnThis(), json: vi.fn() })
const request = (userId, body) => ({ user: { _id: userId, name: 'Teacher' }, params: { id: body.classId }, body })
const waitForNext = async run => {
  const next = vi.fn()
  const res = response()
  await run(res, next)
  return { next, res }
}

describe('serialized teacher quota writes', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    lockRows.clear()
    classRows.clear()
    nextClassId = 0
    failNextSave = false
    installLockStore()
    Subscription.findOne.mockReturnValue({ sort: vi.fn().mockResolvedValue({ maxSponsoredStudents: 1, plan: 'paid' }) })
    SubscriptionPlan.findOne.mockResolvedValue({ maxClasses: 1 })
    Class.findOne.mockResolvedValue(null)
    Class.countDocuments.mockImplementation(async ({ teacher, status, _id }) => [...classRows.values()].filter(row => {
      if (String(row.teacher) !== String(teacher)) return false
      if (_id?.$ne && String(row._id) === String(_id.$ne)) return false
      if (status && typeof status === 'object') return status.$ne ? row.status !== status.$ne : true
      return row.status === status
    }).length)
    Class.create.mockImplementation(async values => {
      const row = { ...values, _id: 'new-class-' + (++nextClassId), status: 'active', students: [], pendingStudents: [] }
      classRows.set(String(row._id), row)
      return row
    })
    Class.findById.mockImplementation(async id => {
      const row = classRows.get(String(id))
      return row ? makeClassDocument(row) : null
    })
    Class.distinct.mockImplementation(async (_field, { teacher, status }) => {
      return [...new Set([...classRows.values()]
        .filter(row => String(row.teacher) === String(teacher) && row.status === status)
        .flatMap(row => row.students.map(String)))]
    })
    User.findOne.mockImplementation(async query => query.email
      ? ({ _id: query.email, email: query.email, name: 'Student' })
      : ({ _id: query._id, role: 'teacher', accountStatus: 'active' }))
  })

  it('serializes concurrent class creation at the active-class cap', async () => {
    const create = name => {
      const next = vi.fn()
      const res = response()
      return createClass({ user: { _id: 'teacher' }, body: { name } }, res, next).then(() => ({ res, next }))
    }

    const outcomes = await Promise.all([create('A'), create('B')])
    expect(outcomes.filter(({ res }) => res.status.mock.calls.some(([status]) => status === 201))).toHaveLength(1)
    expect(outcomes.filter(({ next }) => next.mock.calls.some(([error]) => error?.statusCode === 403))).toHaveLength(1)
    expect(classRows.size).toBe(1)
  })

  it('counts distinct active students across classes during concurrent enrollments', async () => {
    classRows.set('one', { _id: 'one', teacher: 'teacher', status: 'active', students: [], pendingStudents: [] })
    classRows.set('two', { _id: 'two', teacher: 'teacher', status: 'active', students: [], pendingStudents: [] })
    const enroll = (classId, email) => {
      const next = vi.fn()
      const res = response()
      return addStudent(request('teacher', { classId, email }), res, next).then(() => ({ res, next }))
    }

    const outcomes = await Promise.all([enroll('one', 'first'), enroll('two', 'second')])
    expect(outcomes.filter(({ res }) => res.status.mock.calls.some(([status]) => status === 200))).toHaveLength(1)
    expect(outcomes.filter(({ next }) => next.mock.calls.some(([error]) => error?.statusCode === 403))).toHaveLength(1)
    expect([...classRows.values()].flatMap(row => row.students)).toHaveLength(1)
  })

  it('restores archived rosters only after both caps are available', async () => {
    classRows.set('archived', { _id: 'archived', teacher: 'teacher', status: 'archived', students: ['student'], pendingStudents: [] })
    const next = vi.fn()
    const res = response()
    const req = { user: { _id: 'admin' }, params: { id: 'archived' }, body: {} }

    await restoreClassByAdmin(req, res, next)

    expect(next).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(200)
    expect(classRows.get('archived').status).toBe('active')
  })

  it('serializes concurrent active-class reassignments at the target teacher cap', async () => {
    classRows.set('a', { _id: 'a', teacher: 'old-a', status: 'active', students: [], pendingStudents: [] })
    classRows.set('b', { _id: 'b', teacher: 'old-b', status: 'active', students: [], pendingStudents: [] })
    const reassign = id => {
      const next = vi.fn()
      const res = response()
      const req = { user: { _id: 'admin' }, params: { id }, body: { teacherId: 'target' } }
      return updateClassByAdmin(req, res, next).then(() => ({ res, next }))
    }

    const outcomes = await Promise.all([reassign('a'), reassign('b')])
    expect(outcomes.filter(({ res }) => res.status.mock.calls.some(([status]) => status === 200))).toHaveLength(1)
    expect(outcomes.filter(({ next }) => next.mock.calls.some(([error]) => error?.statusCode === 403))).toHaveLength(1)
    expect([...classRows.values()].filter(row => row.teacher === 'target')).toHaveLength(1)
  })

  it('releases the quota lock and re-counts persisted rosters after a failed write', async () => {
    classRows.set('one', { _id: 'one', teacher: 'teacher', status: 'active', students: [], pendingStudents: [] })
    failNextSave = true
    const failed = await waitForNext((res, next) => addStudent(request('teacher', { classId: 'one', email: 'failed' }), res, next))
    expect(failed.next).toHaveBeenCalledWith(expect.objectContaining({ message: 'simulated class write failure' }))

    const succeeded = await waitForNext((res, next) => addStudent(request('teacher', { classId: 'one', email: 'retry' }), res, next))
    expect(succeeded.next).not.toHaveBeenCalled()
    expect(classRows.get('one').students).toEqual(['retry'])
  })

  it('names the target teacher when they have no active plan', async () => {
    classRows.set('a', { _id: 'a', teacher: 'old-a', status: 'active', students: [], pendingStudents: [] })
    Subscription.findOne.mockReturnValue({ sort: vi.fn().mockResolvedValue(null) })
    User.findOne.mockImplementation(async query => query.role
      ? { _id: query._id, role: 'teacher', accountStatus: 'active', name: 'No Plan Teacher' }
      : { _id: query._id, role: 'teacher', accountStatus: 'active' })

    const { next } = await waitForNext((res, n) => updateClassByAdmin(
      { user: { _id: 'admin' }, params: { id: 'a' }, body: { teacherId: 'target' } }, res, n,
    ))

    expect(next).toHaveBeenCalledWith(expect.objectContaining({
      statusCode: 403,
      code: 'TEACHER_HAS_NO_PLAN',
      message: expect.stringContaining('No Plan Teacher'),
    }))
    expect(classRows.get('a').teacher).toBe('old-a')
  })

  it('names the target teacher when their plan is out of slots', async () => {
    classRows.set('a', { _id: 'a', teacher: 'old-a', status: 'active', students: [], pendingStudents: [] })
    // Subscription is present but the plan allows one class and the target
    // already owns one, so only the class cap can refuse this save.
    classRows.set('b', { _id: 'b', teacher: 'target', status: 'active', students: [], pendingStudents: [] })
    User.findOne.mockImplementation(async query => ({ _id: query._id, role: 'teacher', accountStatus: 'active', name: 'Full Teacher' }))

    const { next } = await waitForNext((res, n) => updateClassByAdmin(
      { user: { _id: 'admin' }, params: { id: 'a' }, body: { teacherId: 'target' } }, res, n,
    ))

    expect(next).toHaveBeenCalledWith(expect.objectContaining({
      statusCode: 403,
      code: 'TEACHER_QUOTA_EXCEEDED',
      message: expect.stringContaining('Full Teacher'),
    }))
    expect(classRows.get('a').teacher).toBe('old-a')
  })
})

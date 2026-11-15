import { vi, describe, it, expect, beforeEach } from 'vitest'

vi.mock('../src/models/Essay.js', () => ({ default: { updateMany: vi.fn().mockResolvedValue({ modifiedCount: 0 }) } }))

vi.mock('../src/services/adminMutationLock.service.js', () => ({ withAdminMutationLock: operation => operation() }))

vi.mock('../src/config/db.js', () => ({
  default: vi.fn().mockImplementation(() => Promise.resolve()),
}))

const mocks = vi.hoisted(() => ({
  classFind: vi.fn(),
  classUpdateMany: vi.fn(),
  userFindById: vi.fn(),
  auditCreate: vi.fn(),
  sendEmail: vi.fn(),
  notificationCreate: vi.fn(),
  notificationDeleteMany: vi.fn(),
  childLinkCodeDeleteMany: vi.fn(),
  sendNotificationToUser: vi.fn(),
  syncParentLinkedRooms: vi.fn(),
  disconnectUserSockets: vi.fn(),
}))

function makeClass(fields = {}) {
  const doc = {
    _id: 'class_1',
    name: 'Class A',
    students: [],
    pendingStudents: [],
    teacher: { _id: 'teacher_1', name: 'Teacher', email: 't@example.com' },
    ...fields,
  }
  doc.toObject = () => {
    const plain = { ...doc }
    delete plain.toObject
    return plain
  }
  return doc
}

vi.mock('../src/models/Class.js', () => ({
  default: {
    // getAdminClasses chains .populate(...).sort(...); observe the filter on call.
    find: (...a) => mocks.classFind(...a),
    countDocuments: vi.fn().mockResolvedValue(0),
    updateMany: (...a) => mocks.classUpdateMany(...a),
    findById: vi.fn().mockResolvedValue(null),
  },
}))

function makeUser(overrides = {}) {
  return {
    _id: 'user_1',
    name: 'Jane Student',
    email: 'jane@example.com',
    role: 'student',
    accountStatus: 'active',
    statusNote: '',
    save: vi.fn().mockResolvedValue(true),
    deleteOne: vi.fn().mockResolvedValue(true),
    toObject() { return { ...this } },
    ...overrides,
  }
}

vi.mock('../src/models/User.js', () => ({
  default: {
    findById: (...a) => ({
      select: () => Promise.resolve(mocks.userFindById(...a)),
      then: (resolve, reject) => Promise.resolve(mocks.userFindById(...a)).then(resolve, reject),
    }),
    find: vi.fn(),
    updateMany: vi.fn().mockResolvedValue({ modifiedCount: 0 }),
    countDocuments: vi.fn().mockResolvedValue(0),
    aggregate: vi.fn().mockResolvedValue([]),
  },
}))

vi.mock('../src/models/AuditLog.js', () => ({
  default: {
    create: (...a) => mocks.auditCreate(...a),
    updateMany: vi.fn().mockResolvedValue({ modifiedCount: 0 }),
    countDocuments: vi.fn().mockResolvedValue(0),
    find: vi.fn(),
  },
}))

vi.mock('../src/models/Notification.js', () => ({
  default: {
    create: (...a) => mocks.notificationCreate(...a),
    deleteMany: (...a) => mocks.notificationDeleteMany(...a),
  },
}))

vi.mock('../src/models/ChildLinkCode.js', () => ({
  default: {
    deleteMany: (...a) => mocks.childLinkCodeDeleteMany(...a),
  },
}))

vi.mock('../src/utils/sendEmail.js', () => ({
  default: (...a) => mocks.sendEmail(...a),
}))

vi.mock('../src/services/socket.service.js', () => ({
  sendNotificationToUser: (...a) => mocks.sendNotificationToUser(...a),
  syncParentLinkedRooms: (...a) => mocks.syncParentLinkedRooms(...a),
  disconnectUserSockets: (...a) => mocks.disconnectUserSockets(...a),
}))

vi.mock('../src/models/ParentStudentLink.js', () => ({
  default: { updateMany: vi.fn().mockResolvedValue({ modifiedCount: 0 }) },
}))

vi.mock('../src/models/Subscription.js', () => ({
  default: { updateMany: vi.fn().mockResolvedValue({ modifiedCount: 0 }) },
}))

vi.mock('../src/middleware/auth.middleware.js', () => ({
  protect: (req, res, next) => {
    req.user = { _id: 'admin_1', role: 'admin', name: 'Mock Admin' }
    next()
  },
  authorize: () => (req, res, next) => next(),
  optionalAuth: (req, res, next) => next(),
}))

import request from 'supertest'
import app from '../src/index.js'

// Swapped per test; the chain resolves to this.
let findDocs = []

beforeEach(() => {
  vi.clearAllMocks()
  findDocs = []
  mocks.classFind.mockImplementation(() => {
    const chain = {
      populate: () => chain,
      sort: () => chain,
      skip: () => chain,
      limit: () => Promise.resolve(findDocs),
    }
    return chain
  })
  mocks.classUpdateMany.mockResolvedValue({ modifiedCount: 0 })
  mocks.auditCreate.mockResolvedValue({ _id: 'audit_1' })
  mocks.sendEmail.mockResolvedValue(true)
  mocks.notificationDeleteMany.mockResolvedValue({ deletedCount: 0 })
  mocks.childLinkCodeDeleteMany.mockResolvedValue({ deletedCount: 0 })
  mocks.syncParentLinkedRooms.mockResolvedValue(undefined)
  mocks.disconnectUserSockets.mockResolvedValue(undefined)
  mocks.notificationCreate.mockImplementation((doc) => Promise.resolve({
    _id: 'notif_1', toObject: () => ({ _id: 'notif_1', ...doc }),
  }))
})

describe('GET /api/classes/admin status filter', () => {
  it('defaults to active classes when no status is given', async () => {
    const res = await request(app).get('/api/classes/admin')

    expect(res.status).toBe(200)
    expect(mocks.classFind).toHaveBeenCalledWith({ status: 'active' })
  })

  it('filters archived classes on request', async () => {
    await request(app).get('/api/classes/admin?status=archived').expect(200)
    expect(mocks.classFind).toHaveBeenCalledWith({ status: 'archived' })
  })

  it('filters draft classes on request', async () => {
    await request(app).get('/api/classes/admin?status=draft').expect(200)
    expect(mocks.classFind).toHaveBeenCalledWith({ status: 'draft' })
  })

  it('drops the status constraint for status=all', async () => {
    await request(app).get('/api/classes/admin?status=all').expect(200)
    expect(mocks.classFind).toHaveBeenCalledWith({})
    expect(mocks.classFind.mock.calls[0][0]).not.toHaveProperty('status')
  })

  it('rejects an invalid status without touching the database', async () => {
    const res = await request(app).get('/api/classes/admin?status=bogus')

    expect(res.status).toBe(400)
    expect(mocks.classFind).not.toHaveBeenCalled()
  })

  it('marks teacherMissing when the owning teacher was deleted', async () => {
    findDocs = [makeClass({ _id: 'class_orphan', teacher: null })]
    const res = await request(app).get('/api/classes/admin?status=all')

    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(1)
    expect(res.body.data[0].teacherMissing).toBe(true)
  })

  it('does not mark teacherMissing for a class with a teacher', async () => {
    findDocs = [makeClass()]
    const res = await request(app).get('/api/classes/admin')

    expect(res.body.data[0].teacherMissing).toBe(false)
  })
})

describe('DELETE /api/admin/users/:id class archiving', () => {
  it('archives the classes owned by a deleted teacher', async () => {
    mocks.userFindById.mockResolvedValue(
      makeUser({ _id: 'teacher_1', role: 'teacher', email: 'teacher@example.com' })
    )

    await request(app).delete('/api/admin/users/teacher_1').expect(200)

    expect(mocks.classUpdateMany).toHaveBeenCalledWith(
      { teacher: 'teacher_1' },
      { $set: { status: 'archived' } }
    )
  })

  it('does not archive classes when a student is deleted', async () => {
    mocks.userFindById.mockResolvedValue(makeUser({ _id: 'student_1', role: 'student' }))

    await request(app).delete('/api/admin/users/student_1').expect(200)

    const archiveCall = mocks.classUpdateMany.mock.calls.find(
      ([, update]) => update && update.$set && update.$set.status === 'archived'
    )
    expect(archiveCall).toBeUndefined()
    // The roster cleanup still happens.
    expect(mocks.classUpdateMany).toHaveBeenCalledWith(
      { $or: [{ students: 'student_1' }, { pendingStudents: 'student_1' }] },
      { $pull: { students: 'student_1', pendingStudents: 'student_1' } }
    )
  })

  it('does not archive classes when a parent is deleted', async () => {
    mocks.userFindById.mockResolvedValue(makeUser({ _id: 'parent_1', role: 'parent' }))

    await request(app).delete('/api/admin/users/parent_1').expect(200)

    const archiveCall = mocks.classUpdateMany.mock.calls.find(
      ([, update]) => update && update.$set && update.$set.status === 'archived'
    )
    expect(archiveCall).toBeUndefined()
  })

  it('records archivedClasses in the audit details when classes were archived', async () => {
    mocks.userFindById.mockResolvedValue(
      makeUser({ _id: 'teacher_1', role: 'teacher', email: 'teacher@example.com' })
    )
    mocks.classUpdateMany.mockResolvedValue({ acknowledged: true, modifiedCount: 3 })

    await request(app).delete('/api/admin/users/teacher_1').expect(200)

    const entry = mocks.auditCreate.mock.calls.find(([doc]) => doc.action === 'ADMIN_DELETE_USER')[0]
    expect(entry.details).toEqual(expect.objectContaining({
      email: 'teacher@example.com',
      role: 'teacher',
      archivedClasses: 3,
    }))
  })

  it('omits archivedClasses when no class needed archiving', async () => {
    mocks.userFindById.mockResolvedValue(
      makeUser({ _id: 'teacher_2', role: 'teacher', email: 't2@example.com' })
    )
    mocks.classUpdateMany.mockResolvedValue({ acknowledged: true, modifiedCount: 0 })

    await request(app).delete('/api/admin/users/teacher_2').expect(200)

    const entry = mocks.auditCreate.mock.calls.find(([doc]) => doc.action === 'ADMIN_DELETE_USER')[0]
    expect(entry.details).not.toHaveProperty('archivedClasses')
  })
})

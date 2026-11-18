import { vi, describe, it, expect, beforeEach } from 'vitest'

vi.mock('../src/models/Essay.js', () => ({ default: { updateMany: vi.fn().mockResolvedValue({ modifiedCount: 0 }) } }))

// Controller-only tests; cross-process locking is exercised against MongoDB in adminMutationConcurrency.test.js.
// The mock tracks whether the lock is held so tests can assert what runs inside it.
const lockState = vi.hoisted(() => ({ held: false }))
vi.mock('../src/services/adminMutationLock.service.js', () => ({
  withAdminMutationLock: async operation => {
    lockState.held = true
    try { return await operation() } finally { lockState.held = false }
  },
}))

vi.mock('../src/config/db.js', () => ({
  default: vi.fn().mockImplementation(() => Promise.resolve()),
}))

const mocks = vi.hoisted(() => ({
  userFindById: vi.fn(),
  linkExists: vi.fn(),
  linkUpdateMany: vi.fn(),
  classUpdateMany: vi.fn(),
  auditCreate: vi.fn(),
  sendEmail: vi.fn(),
  notificationCreate: vi.fn(),
  notificationFindOne: vi.fn(),
  notificationDeleteMany: vi.fn(),
  childLinkCodeDeleteMany: vi.fn(),
  sendNotificationToUser: vi.fn(),
  syncParentLinkedRooms: vi.fn(),
  disconnectUserSockets: vi.fn(),
}))

function makeUser(overrides = {}) {
  return {
    _id: 'user_1',
    name: 'Jane Student',
    email: 'jane@example.com',
    role: 'student',
    accountStatus: 'pending_approval',
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

vi.mock('../src/models/Class.js', () => ({
  default: { updateMany: (...a) => mocks.classUpdateMany(...a), exists: vi.fn().mockResolvedValue(null) },
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
    findOne: (...a) => ({
      select: () => ({ lean: () => Promise.resolve(mocks.notificationFindOne(...a)) }),
    }),
    deleteMany: (...a) => mocks.notificationDeleteMany(...a),
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
  default: {
    updateMany: (...a) => mocks.linkUpdateMany(...a),
    exists: (...a) => mocks.linkExists(...a),
  },
}))

vi.mock('../src/models/ChildLinkCode.js', () => ({
  default: {
    deleteMany: (...a) => mocks.childLinkCodeDeleteMany(...a),
  },
}))

vi.mock('../src/models/Subscription.js', () => ({
  default: {
    exists: vi.fn().mockResolvedValue(false),
    updateMany: vi.fn().mockResolvedValue({ modifiedCount: 0 }),
  },
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
import User from '../src/models/User.js'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.auditCreate.mockResolvedValue({ _id: 'audit_1' })
  mocks.linkExists.mockResolvedValue(null)
  mocks.linkUpdateMany.mockResolvedValue({ modifiedCount: 0 })
  mocks.notificationDeleteMany.mockResolvedValue({ deletedCount: 0 })
  mocks.childLinkCodeDeleteMany.mockResolvedValue({ deletedCount: 0 })
  mocks.syncParentLinkedRooms.mockResolvedValue(undefined)
  mocks.disconnectUserSockets.mockResolvedValue(undefined)
  mocks.sendEmail.mockResolvedValue(true)
  mocks.notificationFindOne.mockReturnValue(null)
  mocks.notificationCreate.mockImplementation((doc) => Promise.resolve({
    _id: 'notif_1', toObject: () => ({ _id: 'notif_1', ...doc }),
  }))
})

describe('admin user actions write an audit entry', () => {
  it('records a status change without leaking anything sensitive', async () => {
    mocks.userFindById.mockResolvedValue(makeUser({ accountStatus: 'active' }))

    const res = await request(app)
      .patch('/api/admin/users/user_1/status')
      .send({ status: 'suspended', note: 'spam' })

    expect(res.status).toBe(200)
    expect(mocks.auditCreate).toHaveBeenCalledWith(expect.objectContaining({
      action: 'ADMIN_UPDATE_USER_STATUS',
      targetType: 'User',
      targetId: 'user_1',
      details: expect.objectContaining({ oldStatus: 'active', newStatus: 'suspended', note: 'spam' }),
    }))
  })

  it('rejects transitioning an active user back to pending_approval or exceeding statusNote length', async () => {
    const activeUser = makeUser({ accountStatus: 'active' })
    mocks.userFindById.mockResolvedValue(activeUser)

    await request(app)
      .patch('/api/admin/users/user_1/status')
      .send({ status: 'pending_approval' })
      .expect(422)
    expect(activeUser.save).not.toHaveBeenCalled()

    await request(app)
      .patch('/api/admin/users/user_1/status')
      .send({ status: 'suspended', note: 'x'.repeat(501) })
      .expect(400)
    expect(activeUser.save).not.toHaveBeenCalled()
  })

  it('rejects a non-string status note with a type error, not a length error', async () => {
    const activeUser = makeUser({ accountStatus: 'active' })
    mocks.userFindById.mockResolvedValue(activeUser)

    const res = await request(app)
      .patch('/api/admin/users/user_1/status')
      .send({ status: 'suspended', note: null })
      .expect(400)
    expect(res.body.error).toBe('Status note must be a string')
    expect(activeUser.save).not.toHaveBeenCalled()
  })

  it('stores the same trimmed password it validated', async () => {
    const user = makeUser()
    mocks.userFindById.mockResolvedValue(user)

    await request(app)
      .post('/api/admin/users/user_1/reset-password')
      .send({ newPassword: '  abcdef  ' })
      .expect(200)
    expect(user.password).toBe('abcdef')

    const shortUser = makeUser()
    mocks.userFindById.mockResolvedValue(shortUser)
    await request(app)
      .post('/api/admin/users/user_1/reset-password')
      .send({ newPassword: '   abc   ' })
      .expect(400)
    expect(shortUser.save).not.toHaveBeenCalled()
  })

  it('records a password reset without storing the password', async () => {
    mocks.userFindById.mockResolvedValue(makeUser())

    const res = await request(app)
      .post('/api/admin/users/user_1/reset-password')
      .send({ newPassword: 'super-secret-1' })

    expect(res.status).toBe(200)
    const entry = mocks.auditCreate.mock.calls[0][0]
    expect(entry.action).toBe('ADMIN_RESET_USER_PASSWORD')
    expect(JSON.stringify(entry)).not.toContain('super-secret-1')
  })

  it('records a user deletion', async () => {
    const deletedUser = makeUser({ role: 'student' })
    mocks.userFindById.mockResolvedValue(deletedUser)

    const res = await request(app).delete('/api/admin/users/user_1')

    expect(res.status).toBe(200)
    expect(deletedUser.save).toHaveBeenCalled()
    expect(deletedUser.deleteOne).not.toHaveBeenCalled()
    expect(deletedUser.accountStatus).toBe('deleted')
    expect(deletedUser.email).toBe('deleted-user_1@lexigrow.invalid')
    expect(mocks.auditCreate).toHaveBeenCalledWith(expect.objectContaining({
      action: 'ADMIN_DELETE_USER',
      details: expect.objectContaining({ email: 'jane@example.com', role: 'student' }),
    }))
  })

  it('drops the deleted user from class rosters and pending lists', async () => {
    mocks.userFindById.mockResolvedValue(makeUser({ _id: 'user_1', role: 'student' }))

    await request(app).delete('/api/admin/users/user_1').expect(200)

    expect(mocks.classUpdateMany).toHaveBeenCalledWith(
      { $or: [{ students: 'user_1' }, { pendingStudents: 'user_1' }] },
      { $pull: { students: 'user_1', pendingStudents: 'user_1' } }
    )
  })

  it('removes a deleted parent from every student and revokes both link directions', async () => {
    mocks.userFindById.mockResolvedValue(makeUser({
      _id: 'parent_1',
      role: 'parent',
      accountStatus: 'active',
      children: ['child_1'],
    }))
    mocks.linkUpdateMany.mockResolvedValue({ modifiedCount: 1 })
    mocks.notificationDeleteMany.mockResolvedValue({ deletedCount: 2 })

    await request(app).delete('/api/admin/users/parent_1').expect(200)

    expect(mocks.linkUpdateMany).toHaveBeenCalledWith(
      { $or: [{ parent: 'parent_1' }, { student: 'parent_1' }], status: 'active' },
      { $set: expect.objectContaining({ status: 'revoked' }) }
    )
    expect(User.updateMany).toHaveBeenCalledWith(
      { parents: 'parent_1' },
      { $pull: { parents: 'parent_1' } }
    )
    expect(mocks.notificationDeleteMany).toHaveBeenCalledWith({
      $or: [{ recipient: 'parent_1' }, { relatedUser: 'parent_1' }],
    })
    expect(mocks.disconnectUserSockets).toHaveBeenCalledWith('parent_1')
    expect(mocks.auditCreate).toHaveBeenCalledWith(expect.objectContaining({
      action: 'ADMIN_DELETE_USER',
      details: expect.objectContaining({
        revokedParentLinks: 1,
        deletedNotifications: 2,
      }),
    }))
  })

  it('clears child link codes and evicts parent sockets when a student is deleted', async () => {
    mocks.userFindById.mockResolvedValue(makeUser({
      _id: 'student_1',
      role: 'student',
      accountStatus: 'active',
      parents: ['parent_1', 'parent_2'],
    }))
    mocks.childLinkCodeDeleteMany.mockResolvedValue({ deletedCount: 1 })

    await request(app).delete('/api/admin/users/student_1').expect(200)

    expect(mocks.childLinkCodeDeleteMany).toHaveBeenCalledWith({ student: 'student_1' })
    expect(mocks.syncParentLinkedRooms).toHaveBeenCalledWith(
      'parent_1',
      { revokedStudentId: 'student_1' }
    )
    expect(mocks.syncParentLinkedRooms).toHaveBeenCalledWith(
      'parent_2',
      { revokedStudentId: 'student_1' }
    )
    expect(User.updateMany).toHaveBeenCalledWith(
      { children: 'student_1' },
      { $pull: { children: 'student_1' } }
    )
  })

  it('archives active classes and records archivedClasses in audit log when teacher is deleted', async () => {
    mocks.userFindById.mockResolvedValue(makeUser({ _id: 'teacher_1', role: 'teacher', email: 'teacher@example.com' }))
    mocks.classUpdateMany.mockResolvedValue({ acknowledged: true, modifiedCount: 3 })

    await request(app).delete('/api/admin/users/teacher_1').expect(200)

    expect(mocks.classUpdateMany).toHaveBeenCalledWith(
      { teacher: 'teacher_1' },
      { $set: { status: 'archived' } }
    )
    expect(mocks.auditCreate).toHaveBeenCalledWith(expect.objectContaining({
      action: 'ADMIN_DELETE_USER',
      details: expect.objectContaining({
        email: 'teacher@example.com',
        role: 'teacher',
        archivedClasses: 3,
      }),
    }))
  })

  it('records an approval', async () => {
    mocks.userFindById.mockResolvedValue(makeUser())

    const res = await request(app).post('/api/admin/approvals/user_1/approve')

    expect(res.status).toBe(200)
    expect(mocks.auditCreate).toHaveBeenCalledWith(expect.objectContaining({
      action: 'ADMIN_APPROVE_USER',
    }))
  })

  it('records a rejection with its reason', async () => {
    mocks.userFindById.mockResolvedValue(makeUser())

    const res = await request(app)
      .post('/api/admin/approvals/user_1/reject')
      .send({ reason: 'documents missing' })

    expect(res.status).toBe(200)
    expect(mocks.auditCreate).toHaveBeenCalledWith(expect.objectContaining({
      action: 'ADMIN_REJECT_USER',
      details: expect.objectContaining({ reason: 'documents missing' }),
    }))
  })

  it('falls back to the default reason when the rejection reason is blank', async () => {
    for (const body of [{}, { reason: '' }, { reason: '   ' }, { reason: null }]) {
      mocks.sendEmail.mockClear()
      mocks.auditCreate.mockClear()
      mocks.userFindById.mockResolvedValue(makeUser())
      await request(app).post('/api/admin/approvals/user_1/reject').send(body).expect(200)
      expect(mocks.auditCreate).toHaveBeenCalledWith(expect.objectContaining({
        details: expect.objectContaining({ reason: 'Không đáp ứng yêu cầu của hệ thống.' }),
      }))
      expect(mocks.sendEmail.mock.calls[0][0].message).toContain('Lý do: Không đáp ứng yêu cầu của hệ thống.')
    }
  })

  it('trims the rejection reason before storing and emailing it', async () => {
    mocks.userFindById.mockResolvedValue(makeUser())
    await request(app).post('/api/admin/approvals/user_1/reject').send({ reason: '  thiếu giấy tờ  ' }).expect(200)
    expect(mocks.auditCreate).toHaveBeenCalledWith(expect.objectContaining({
      details: expect.objectContaining({ reason: 'thiếu giấy tờ' }),
    }))
  })

  it('refuses a non-string or over-long rejection reason without touching the user', async () => {
    const user = makeUser()
    mocks.userFindById.mockResolvedValue(user)

    const typed = await request(app).post('/api/admin/approvals/user_1/reject').send({ reason: { $ne: '' } })
    expect(typed.status).toBe(400)
    expect(typed.body.error).toBe('Rejection reason must be a string')

    const long = await request(app).post('/api/admin/approvals/user_1/reject').send({ reason: 'x'.repeat(501) })
    expect(long.status).toBe(400)
    expect(long.body.error).toBe('Rejection reason cannot exceed 500 characters')

    await request(app).post('/api/admin/approvals/user_1/reject').send({ reason: 'x'.repeat(500) }).expect(200)
    expect(mocks.auditCreate).toHaveBeenCalledTimes(1)
  })

  it('sends approval and rejection emails after the admin mutation lock is released', async () => {
    const heldDuringEmail = []
    mocks.sendEmail.mockImplementation(async () => { heldDuringEmail.push(lockState.held) })

    mocks.userFindById.mockResolvedValue(makeUser())
    await request(app).post('/api/admin/approvals/user_1/approve').expect(200)
    mocks.userFindById.mockResolvedValue(makeUser())
    await request(app).post('/api/admin/approvals/user_1/reject').send({ reason: 'x' }).expect(200)

    expect(heldDuringEmail).toEqual([false, false])
  })

  it('still approves when the approval email fails', async () => {
    mocks.sendEmail.mockRejectedValue(new Error('SMTP down'))
    mocks.userFindById.mockResolvedValue(makeUser())

    const res = await request(app).post('/api/admin/approvals/user_1/approve')

    expect(res.status).toBe(200)
    expect(res.body.data.accountStatus).toBe('active')
  })

  it('escapes the display name before it reaches the approval email HTML', async () => {
    mocks.userFindById.mockResolvedValue(makeUser({ name: '<img src=x onerror=alert(1)>' }))

    const res = await request(app).post('/api/admin/approvals/user_1/approve')

    expect(res.status).toBe(200)
    const html = mocks.sendEmail.mock.calls[0][0].html
    expect(html).not.toContain('<img src=x onerror=alert(1)>')
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
  })

  it('escapes the rejection reason so a crafted reason cannot inject markup', async () => {
    mocks.userFindById.mockResolvedValue(makeUser())

    const res = await request(app)
      .post('/api/admin/approvals/user_1/reject')
      .send({ reason: '<script>steal()</script>' })

    expect(res.status).toBe(200)
    const html = mocks.sendEmail.mock.calls[0][0].html
    expect(html).not.toContain('<script>steal()</script>')
    expect(html).toContain('&lt;script&gt;steal()&lt;/script&gt;')
  })

  it('records a role change', async () => {
    mocks.userFindById.mockResolvedValue(makeUser({ role: 'student' }))

    const res = await request(app)
      .patch('/api/admin/users/user_1/role')
      .send({ role: 'teacher' })

    expect(res.status).toBe(200)
    expect(mocks.auditCreate).toHaveBeenCalledWith(expect.objectContaining({
      action: 'ADMIN_UPDATE_ROLE',
    }))
  })

  it('refuses to reset the password of another admin', async () => {
    const otherAdmin = makeUser({ _id: 'admin_2', role: 'admin', accountStatus: 'active' })
    mocks.userFindById.mockResolvedValue(otherAdmin)

    const res = await request(app)
      .post('/api/admin/users/admin_2/reset-password')
      .send({ newPassword: 'super-secret-1' })

    expect(res.status).toBe(403)
    expect(otherAdmin.save).not.toHaveBeenCalled()
  })

  it('refuses to change the role of a parent that still has linked children', async () => {
    mocks.userFindById.mockResolvedValue(makeUser({ role: 'parent', accountStatus: 'active', children: ['child_1'] }))

    const res = await request(app)
      .patch('/api/admin/users/user_1/role')
      .send({ role: 'teacher' })

    expect(res.status).toBe(409)
  })

  it('refuses to change the role of a student with an active parent link', async () => {
    mocks.userFindById.mockResolvedValue(makeUser({ role: 'student', accountStatus: 'active' }))
    mocks.linkExists.mockResolvedValue({ _id: 'link_1' })

    const res = await request(app)
      .patch('/api/admin/users/user_1/role')
      .send({ role: 'teacher' })

    expect(res.status).toBe(409)
  })

  it('refuses parent verification when the target is not a parent or the child is not an active student', async () => {
    mocks.userFindById.mockResolvedValue(makeUser({ role: 'teacher', children: ['child_1'] }))
    await request(app).post('/api/admin/approvals/user_1/verify-via-student').expect(400)

    const parent = makeUser({ _id: 'parent_1', role: 'parent', children: ['child_1'] })
    mocks.userFindById.mockImplementation((id) => (
      id === 'parent_1' ? parent : makeUser({ _id: 'child_1', accountStatus: 'suspended' })
    ))
    await request(app).post('/api/admin/approvals/parent_1/verify-via-student').expect(404)
    expect(mocks.notificationCreate).not.toHaveBeenCalled()
  })

  it('records a parent verification request', async () => {
    const parent = makeUser({
      _id: 'parent_1',
      role: 'parent',
      email: 'parent@example.com',
      children: ['child_1'],
    })
    mocks.userFindById.mockImplementation((id) => (
      id === 'parent_1' ? parent : makeUser({ _id: 'child_1', email: 'child@example.com', accountStatus: 'active' })
    ))

    const res = await request(app).post('/api/admin/approvals/parent_1/verify-via-student')

    expect(res.status).toBe(200)
    expect(mocks.auditCreate).toHaveBeenCalledWith(expect.objectContaining({
      action: 'ADMIN_SEND_STUDENT_VERIFICATION',
      details: expect.objectContaining({
        parentEmail: 'parent@example.com',
        childEmail: 'child@example.com',
      }),
    }))
  })

  it('supports sending verification to a specific child when childId is provided in body', async () => {
    const parent = makeUser({
      _id: 'parent_1',
      role: 'parent',
      email: 'parent@example.com',
      children: ['child_1', 'child_2'],
    })
    mocks.userFindById.mockImplementation((id) => {
      if (id === 'parent_1') return parent
      if (id === 'child_2') return makeUser({ _id: 'child_2', email: 'child2@example.com', accountStatus: 'active' })
      return makeUser({ _id: 'child_1', email: 'child1@example.com', accountStatus: 'active' })
    })

    const res = await request(app)
      .post('/api/admin/approvals/parent_1/verify-via-student')
      .send({ childId: 'child_2' })

    expect(res.status).toBe(200)
    expect(mocks.auditCreate).toHaveBeenCalledWith(expect.objectContaining({
      action: 'ADMIN_SEND_STUDENT_VERIFICATION',
      details: expect.objectContaining({
        parentEmail: 'parent@example.com',
        childEmail: 'child2@example.com',
      }),
    }))
  })

  it('sends the student verification notification in Vietnamese', async () => {
    const parent = makeUser({ _id: 'parent_1', role: 'parent', name: 'Phụ Huynh A', email: 'parent@example.com', children: ['child_1'] })
    mocks.userFindById.mockImplementation((id) => (
      id === 'parent_1' ? parent : makeUser({ _id: 'child_1', accountStatus: 'active' })
    ))

    await request(app).post('/api/admin/approvals/parent_1/verify-via-student').expect(200)

    expect(mocks.notificationCreate).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Xác nhận liên kết phụ huynh',
      message: 'Phụ huynh Phụ Huynh A (parent@example.com) muốn liên kết với tài khoản của bạn. Vui lòng xác nhận.',
      type: 'parent_notice',
      relatedUser: 'parent_1',
    }))
  })

  it('does not stack a second verification while the first is still unanswered', async () => {
    const parent = makeUser({ _id: 'parent_1', role: 'parent', children: ['child_1'] })
    mocks.userFindById.mockImplementation((id) => (
      id === 'parent_1' ? parent : makeUser({ _id: 'child_1', accountStatus: 'active' })
    ))
    mocks.notificationFindOne.mockReturnValue({ createdAt: new Date(Date.now() - 4 * 60 * 1000) })

    const res = await request(app).post('/api/admin/approvals/parent_1/verify-via-student')

    expect(res.status).toBe(429)
    expect(res.body.error).toContain('6 minute')
    expect(res.body.code).toBe('VERIFICATION_ALREADY_SENT')
    expect(mocks.notificationCreate).not.toHaveBeenCalled()
    expect(mocks.auditCreate).not.toHaveBeenCalled()
    const [filter] = mocks.notificationFindOne.mock.calls[0]
    expect(filter).toMatchObject({ recipient: 'child_1', relatedUser: 'parent_1', type: 'parent_notice', isRead: false })
    expect(Date.now() - filter.createdAt.$gte.getTime()).toBeGreaterThanOrEqual(10 * 60 * 1000 - 1000)
  })

  it('runs the verification inside the admin mutation lock', async () => {
    const parent = makeUser({ _id: 'parent_1', role: 'parent', children: ['child_1'] })
    mocks.userFindById.mockImplementation((id) => (
      id === 'parent_1' ? parent : makeUser({ _id: 'child_1', accountStatus: 'active' })
    ))
    let heldOnCreate = null
    mocks.notificationCreate.mockImplementation(async (doc) => {
      heldOnCreate = lockState.held
      return { _id: 'notif_1', toObject: () => ({ _id: 'notif_1', ...doc }) }
    })

    await request(app).post('/api/admin/approvals/parent_1/verify-via-student').expect(200)
    expect(heldOnCreate).toBe(true)
  })

  it('rejects student verification when childId is not associated with parent', async () => {
    const parent = makeUser({
      _id: 'parent_1',
      role: 'parent',
      email: 'parent@example.com',
      children: ['child_1'],
    })
    mocks.userFindById.mockResolvedValue(parent)

    const res = await request(app)
      .post('/api/admin/approvals/parent_1/verify-via-student')
      .send({ childId: 'unlinked_child' })

    expect(res.status).toBe(400)
  })
})

describe('updateUserRole guards', () => {
  it('refuses to change your own role', async () => {
    mocks.userFindById.mockResolvedValue(makeUser({ _id: 'admin_1', role: 'admin' }))

    const res = await request(app)
      .patch('/api/admin/users/admin_1/role')
      .send({ role: 'teacher' })

    expect(res.status).toBe(403)
    expect(mocks.auditCreate).not.toHaveBeenCalled()
  })
})

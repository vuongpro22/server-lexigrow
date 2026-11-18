import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'

vi.mock('../src/config/db.js', () => ({
  default: vi.fn().mockImplementation(() => Promise.resolve()),
}))

const mocks = vi.hoisted(() => ({
  classFindById: vi.fn(),
  classUpdateMany: vi.fn(),
  classUpdateOne: vi.fn(),
  classDistinct: vi.fn(),
  userFindById: vi.fn(),
  quotaLockCreate: vi.fn(),
  quotaLockFindOneAndUpdate: vi.fn(),
  planFindById: vi.fn(),
  planDeleteOne: vi.fn(),
  subscriptionCountDocuments: vi.fn(),
  subscriptionFind: vi.fn(),
  transactionCountDocuments: vi.fn(),
  auditCreate: vi.fn(),
  auditLogCreate: vi.fn(),
  userAggregate: vi.fn(),
  userCountDocuments: vi.fn(),
  userFind: vi.fn(),
}))

vi.mock('../src/models/TeacherQuotaLock.js', () => ({
  default: {
    create: (...args) => mocks.quotaLockCreate(...args),
    findOneAndUpdate: (...args) => mocks.quotaLockFindOneAndUpdate(...args),
  },
}))

vi.mock('../src/models/Class.js', () => ({
  default: {
    findById: (...a) => mocks.classFindById(...a),
    updateMany: (...a) => mocks.classUpdateMany(...a),
    updateOne: (...a) => mocks.classUpdateOne(...a),
    distinct: (...a) => mocks.classDistinct(...a),
  },
}))

vi.mock('../src/models/User.js', () => ({
  default: {
    // Handlers chain .select() on the findById result.
    findById: (...a) => ({
      select: () => Promise.resolve(mocks.userFindById(...a)),
      then: (resolve, reject) => Promise.resolve(mocks.userFindById(...a)).then(resolve, reject),
    }),
    find: (...a) => mocks.userFind(...a),
    countDocuments: (...a) => mocks.userCountDocuments(...a),
    aggregate: (...a) => mocks.userAggregate(...a),
  },
}))

vi.mock('../src/models/SubscriptionPlan.js', () => ({
  default: {
    findById: (...a) => mocks.planFindById(...a),
    deleteOne: (...a) => mocks.planDeleteOne(...a),
    find: vi.fn().mockReturnValue({ sort: vi.fn().mockResolvedValue([]) }),
    findOne: vi.fn().mockResolvedValue(null),
  },
}))

vi.mock('../src/models/Subscription.js', () => ({
  default: {
    countDocuments: (...a) => mocks.subscriptionCountDocuments(...a),
    find: (...a) => mocks.subscriptionFind(...a),
    findOne: vi.fn().mockResolvedValue(null),
  },
}))

vi.mock('../src/models/PaymentTransaction.js', () => ({
  default: {
    countDocuments: (...a) => mocks.transactionCountDocuments(...a),
    find: vi.fn(),
  },
}))

vi.mock('../src/models/AuditLog.js', () => ({
  default: {
    create: (...a) => mocks.auditLogCreate(...a),
    countDocuments: vi.fn().mockResolvedValue(0),
    // getAuditLogs chains sort().skip().limit().populate()
    find: vi.fn((filter) => {
      if (filter?.action === 'ADMIN_DELETE_USER') {
        return { select: () => ({ lean: async () => [] }) }
      }
      const populate = vi.fn().mockResolvedValue([])
      const limit = vi.fn().mockReturnValue({ populate })
      const skip = vi.fn().mockReturnValue({ limit })
      const sort = vi.fn().mockReturnValue({ skip })
      return { sort }
    }),
  },
}))

vi.mock('../src/models/AILog.js', () => ({
  default: { countDocuments: vi.fn().mockResolvedValue(0), find: vi.fn(), aggregate: vi.fn().mockResolvedValue([]) },
}))

vi.mock('../src/models/Essay.js', () => ({
  default: { countDocuments: vi.fn().mockResolvedValue(0), aggregate: vi.fn().mockResolvedValue([]) },
}))

vi.mock('../src/models/AIAnalysis.js', () => ({
  default: { find: vi.fn().mockReturnValue({ select: vi.fn().mockResolvedValue([]) }), aggregate: vi.fn().mockResolvedValue([]) },
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
import mongoose from 'mongoose'
import app from '../src/index.js'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.auditLogCreate.mockResolvedValue({ _id: 'audit_1' })
  mocks.classUpdateMany.mockResolvedValue({ modifiedCount: 0 })
  mocks.classDistinct.mockResolvedValue([])
  mocks.subscriptionFind.mockReturnValue({ sort: vi.fn().mockResolvedValue([{ maxSponsoredStudents: 10 }]) })
  mocks.quotaLockCreate.mockImplementation(async () => {
    throw Object.assign(new Error('Duplicate key'), { code: 11000 })
  })
  mocks.quotaLockFindOneAndUpdate.mockResolvedValue({ _id: 'teacher_1' })
})

describe('POST /api/classes/admin/transfer', () => {
  it('leaves the old class untouched when the target class does not exist', async () => {
    const fromClass = {
      _id: 'class_old',
      name: 'Old',
      students: ['student_1'],
      save: vi.fn().mockResolvedValue(true),
    }

    mocks.userFindById.mockResolvedValue({ _id: 'student_1', email: 's@x.com', role: 'student', accountStatus: 'active' })
    mocks.classFindById.mockImplementation((id) => {
      if (id === 'class_missing') return Promise.resolve(null)
      if (id === 'class_old') return Promise.resolve(fromClass)
      return Promise.resolve(null)
    })

    const res = await request(app)
      .post('/api/classes/admin/transfer')
      .send({ studentId: 'student_1', fromClassId: 'class_old', toClassId: 'class_missing' })

    expect(res.status).toBe(404)
    expect(fromClass.save).not.toHaveBeenCalled()
    expect(fromClass.students).toEqual(['student_1'])
    expect(mocks.classUpdateMany).not.toHaveBeenCalled()
  })

  it('rejects a transfer of a suspended student or into an archived class', async () => {
    mocks.userFindById.mockResolvedValue({ _id: 'student_1', email: 's@x.com', role: 'student', accountStatus: 'suspended' })
    mocks.classFindById.mockResolvedValue({ _id: 'class_new', name: 'New', students: [], status: 'active' })
    await request(app)
      .post('/api/classes/admin/transfer')
      .send({ studentId: 'student_1', toClassId: 'class_new' })
      .expect(404)

    mocks.userFindById.mockResolvedValue({ _id: 'student_1', email: 's@x.com', role: 'student', accountStatus: 'active' })
    mocks.classFindById.mockResolvedValue({ _id: 'class_new', name: 'New', students: [], status: 'archived' })
    await request(app)
      .post('/api/classes/admin/transfer')
      .send({ studentId: 'student_1', toClassId: 'class_new' })
      .expect(400)
    expect(mocks.classUpdateOne).not.toHaveBeenCalled()
  })

  it('rejects a transfer to the same class', async () => {
    const res = await request(app)
      .post('/api/classes/admin/transfer')
      .send({ studentId: 'student_1', fromClassId: 'class_a', toClassId: 'class_a' })

    expect(res.status).toBe(400)
    expect(mocks.userFindById).not.toHaveBeenCalled()
  })

  it('records an audit entry when the transfer succeeds', async () => {
    const fromClass = { _id: 'class_old', name: 'Old', students: ['student_1'], save: vi.fn().mockResolvedValue(true) }
    const toClass = { _id: 'class_new', name: 'New', students: [], save: vi.fn().mockResolvedValue(true) }

    mocks.userFindById.mockResolvedValue({ _id: 'student_1', email: 's@x.com', role: 'student', accountStatus: 'active' })
    mocks.classFindById.mockImplementation((id) => Promise.resolve(id === 'class_old' ? fromClass : toClass))

    const res = await request(app)
      .post('/api/classes/admin/transfer')
      .send({ studentId: 'student_1', fromClassId: 'class_old', toClassId: 'class_new' })

    expect(res.status).toBe(200)
    expect(mocks.classUpdateOne).toHaveBeenCalledWith(
      { _id: 'class_old' },
      { $pull: { students: 'student_1' } }
    )
    expect(mocks.classUpdateOne).toHaveBeenCalledWith(
      { _id: 'class_new' },
      { $addToSet: { students: 'student_1' }, $pull: { pendingStudents: 'student_1' } }
    )
    expect(mocks.auditLogCreate).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'TRANSFER_STUDENT', targetId: 'class_new' })
    )
  })

  it('falls back to standalone writes when transaction startup rejects retryable writes', async () => {
    const previousReadyState = mongoose.connection.readyState
    const startSession = vi.spyOn(mongoose, 'startSession').mockResolvedValue({
      withTransaction: vi.fn().mockRejectedValue(new Error('This MongoDB deployment does not support retryable writes. Please add retryWrites=false to your connection string.')),
      endSession: vi.fn().mockResolvedValue(undefined),
    })
    mongoose.connection.readyState = 1
    const fromClass = { _id: 'class_old', teacher: 'teacher_1', students: ['student_1'] }
    const toClass = { _id: 'class_new', teacher: 'teacher_1', students: [], status: 'active' }
    mocks.userFindById.mockResolvedValue({ _id: 'student_1', email: 's@x.com', role: 'student', accountStatus: 'active' })
    mocks.classFindById.mockImplementation((id) => Promise.resolve(id === 'class_old' ? fromClass : toClass))

    try {
      await request(app)
        .post('/api/classes/admin/transfer')
        .send({ studentId: 'student_1', fromClassId: 'class_old', toClassId: 'class_new' })
        .expect(200)

      expect(startSession).toHaveBeenCalledOnce()
      expect(mocks.classUpdateOne).toHaveBeenCalledWith(
        { _id: 'class_new' },
        { $addToSet: { students: 'student_1' }, $pull: { pendingStudents: 'student_1' } },
      )
      expect(mocks.classUpdateOne).toHaveBeenCalledWith(
        { _id: 'class_old' },
        { $pull: { students: 'student_1' } },
      )
    } finally {
      startSession.mockRestore()
      mongoose.connection.readyState = previousReadyState
    }
  })

  it('only vacates active classes when no source class is given', async () => {
    const toClass = { _id: 'class_new', name: 'New', students: [], save: vi.fn().mockResolvedValue(true) }

    mocks.userFindById.mockResolvedValue({ _id: 'student_1', email: 's@x.com', role: 'student', accountStatus: 'active' })
    mocks.classFindById.mockResolvedValue(toClass)

    const res = await request(app)
      .post('/api/classes/admin/transfer')
      .send({ studentId: 'student_1', toClassId: 'class_new' })

    expect(res.status).toBe(200)

    // The target must be excluded from the pull, otherwise its roster is emptied.
    const pullFilter = mocks.classUpdateMany.mock.calls[0][0]
    // Archived classes keep their historical roster.
    expect(pullFilter).toEqual({
      students: 'student_1',
      _id: { $ne: 'class_new' },
      status: 'active',
    })

    // Membership is asserted atomically rather than through the stale snapshot.
    expect(mocks.classUpdateOne).toHaveBeenCalledWith(
      { _id: 'class_new' },
      { $addToSet: { students: 'student_1' }, $pull: { pendingStudents: 'student_1' } }
    )
    expect(toClass.save).not.toHaveBeenCalled()
  })

  it('refuses to transfer a student into a class they already attend', async () => {
    // Accepting it would only drop the student from the source while the UI
    // reports a transfer.
    const toClass = { _id: 'class_new', name: 'New', students: ['student_1'], save: vi.fn().mockResolvedValue(true) }

    mocks.userFindById.mockResolvedValue({ _id: 'student_1', email: 's@x.com', role: 'student', accountStatus: 'active' })
    mocks.classFindById.mockResolvedValue(toClass)

    const res = await request(app)
      .post('/api/classes/admin/transfer')
      .send({ studentId: 'student_1', toClassId: 'class_new' })

    expect(res.status).toBe(409)
    expect(res.body.error).toBe('Student is already in the target class')
    expect(res.body.code).toBe('STUDENT_ALREADY_IN_CLASS')
    expect(mocks.classUpdateOne).not.toHaveBeenCalled()
    expect(mocks.classUpdateMany).not.toHaveBeenCalled()
    expect(mocks.auditCreate).not.toHaveBeenCalled()
  })
})

describe('POST /api/classes/admin/:id/unenroll', () => {
  function makeRoster(fields = {}) {
    return { _id: 'class_1', name: 'Roster', teacher: 'teacher_1', students: ['student_1'], pendingStudents: ['student_2'], save: vi.fn().mockResolvedValue(true), ...fields }
  }

  it('rejects a request without a studentId', async () => {
    mocks.classFindById.mockResolvedValue(makeRoster())
    const res = await request(app).post('/api/classes/admin/class_1/unenroll').send({})
    expect(res.status).toBe(400)
    expect(mocks.auditLogCreate).not.toHaveBeenCalled()
  })

  it('refuses to report a removal for a student who is not in the class', async () => {
    const cls = makeRoster()
    mocks.classFindById.mockResolvedValue(cls)
    const res = await request(app).post('/api/classes/admin/class_1/unenroll').send({ studentId: 'student_9' })
    expect(res.status).toBe(404)
    expect(cls.save).not.toHaveBeenCalled()
    expect(mocks.auditLogCreate).not.toHaveBeenCalled()
  })

  it('removes an enrolled student and audits it', async () => {
    const cls = makeRoster()
    mocks.classFindById.mockResolvedValue(cls)
    const res = await request(app).post('/api/classes/admin/class_1/unenroll').send({ studentId: 'student_1' })
    expect(res.status).toBe(200)
    expect(cls.students).toEqual([])
    expect(cls.pendingStudents).toEqual(['student_2'])
    expect(mocks.auditLogCreate).toHaveBeenCalledWith(expect.objectContaining({ action: 'FORCE_UNENROLL_STUDENT' }))
  })

  it('also clears a pending join request', async () => {
    const cls = makeRoster()
    mocks.classFindById.mockResolvedValue(cls)
    const res = await request(app).post('/api/classes/admin/class_1/unenroll').send({ studentId: 'student_2' })
    expect(res.status).toBe(200)
    expect(cls.pendingStudents).toEqual([])
    expect(cls.students).toEqual(['student_1'])
  })
})

describe('DELETE /api/admin/pricing/plans/:id', () => {
  it('refuses to delete a plan that still has subscriptions', async () => {
    mocks.planFindById.mockResolvedValue({ _id: 'plan_1', name: 'Pro', slug: 'pro' })
    mocks.subscriptionCountDocuments.mockResolvedValue(3)
    mocks.transactionCountDocuments.mockResolvedValue(0)

    const res = await request(app).delete('/api/admin/pricing/plans/plan_1')

    expect(res.status).toBe(409)
    expect(res.body.error).toContain('3')
    expect(mocks.planDeleteOne).not.toHaveBeenCalled()
  })

  it('refuses when only payment transactions reference the plan', async () => {
    mocks.planFindById.mockResolvedValue({ _id: 'plan_1', name: 'Pro', slug: 'pro' })
    mocks.subscriptionCountDocuments.mockResolvedValue(0)
    mocks.transactionCountDocuments.mockResolvedValue(2)

    const res = await request(app).delete('/api/admin/pricing/plans/plan_1')

    expect(res.status).toBe(409)
    expect(mocks.planDeleteOne).not.toHaveBeenCalled()
  })

  it('deletes an unreferenced plan and checks both plan ObjectId and planSlug', async () => {
    mocks.planFindById.mockResolvedValue({ _id: 'plan_1', name: 'Pro', slug: 'pro' })
    mocks.subscriptionCountDocuments.mockResolvedValue(0)
    mocks.transactionCountDocuments.mockResolvedValue(0)
    mocks.planDeleteOne.mockResolvedValue({ deletedCount: 1 })

    const res = await request(app).delete('/api/admin/pricing/plans/plan_1')

    expect(res.status).toBe(200)
    expect(mocks.subscriptionCountDocuments).toHaveBeenCalledWith({
      $or: [{ plan: 'plan_1' }, { planSlug: 'pro' }],
    })
    expect(mocks.transactionCountDocuments).toHaveBeenCalledWith({
      $or: [{ plan: 'plan_1' }, { planSlug: 'pro' }],
    })
    expect(mocks.planDeleteOne).toHaveBeenCalled()
  })
})

describe('GET /api/admin/users query handling', () => {
  function chainReturning(items) {
    const limit = vi.fn().mockResolvedValue(items)
    const skip = vi.fn().mockReturnValue({ limit })
    const sort = vi.fn().mockReturnValue({ skip })
    const select = vi.fn().mockReturnValue({ sort })
    return { select, sort, skip, limit }
  }

  it('clamps a huge limit instead of returning the whole collection', async () => {
    const chain = chainReturning([])
    mocks.userFind.mockReturnValue(chain)
    mocks.userCountDocuments.mockResolvedValue(1000)
    mocks.userAggregate.mockResolvedValue([])

    await request(app).get('/api/admin/users?limit=100000').expect(200)

    expect(chain.limit).toHaveBeenCalledWith(100)
  })

  it('escapes regex metacharacters in the search term', async () => {
    const chain = chainReturning([])
    mocks.userFind.mockReturnValue(chain)
    mocks.userCountDocuments.mockResolvedValue(0)
    mocks.userAggregate.mockResolvedValue([])

    await request(app).get('/api/admin/users?search=' + encodeURIComponent('(a+)+$')).expect(200)

    const query = mocks.userFind.mock.calls[0][0]
    const regex = query.$or[0].name.$regex
    expect(regex).toBe('\\(a\\+\\)\\+\\$')
    // Constructing a RegExp from it must not throw or behave as a pattern.
    expect(() => new RegExp(regex)).not.toThrow()
  })
})

describe('GET /api/admin/logs search handling', () => {
  it('rejects invalid date filters as a client error', async () => {
    await request(app).get('/api/admin/logs?startDate=not-a-date').expect(400)
    await request(app).get('/api/admin/ai/logs?endDate=not-a-date').expect(400)
  })

  it('escapes regex metacharacters in the performer search', async () => {
    // getAuditLogs does User.find(...).select('_id') then maps the result.
    mocks.userFind.mockReturnValue({ select: vi.fn().mockResolvedValue([]) })

    await request(app)
      .get('/api/admin/logs?search=' + encodeURIComponent('(a+)+$'))
      .expect(200)

    const userQuery = mocks.userFind.mock.calls[0][0]
    const regex = userQuery.$or[0].name.$regex
    expect(regex).toBe('\\(a\\+\\)\\+\\$')
    expect(() => new RegExp(regex)).not.toThrow()
  })
})

describe('GET /api/admin/approvals query handling', () => {
  it('clamps a huge limit instead of returning every pending user', async () => {
    const limit = vi.fn().mockResolvedValue([])
    const skip = vi.fn().mockReturnValue({ limit })
    const sort = vi.fn().mockReturnValue({ skip })
    const select = vi.fn().mockReturnValue({ sort })
    const populate = vi.fn().mockReturnValue({ select })
    mocks.userFind.mockReturnValue({ populate })
    mocks.userCountDocuments.mockResolvedValue(500)

    await request(app).get('/api/admin/approvals?limit=100000').expect(200)

    expect(limit).toHaveBeenCalledWith(100)
  })
})

describe('POST /api/classes/admin/:id/enroll', () => {
  it('refuses to enroll a student into an archived class', async () => {
    const cls = { _id: 'class_a', name: 'A', status: 'archived', students: [], pendingStudents: [], save: vi.fn() }
    mocks.classFindById.mockResolvedValue(cls)

    const res = await request(app)
      .post('/api/classes/admin/class_a/enroll')
      .send({ studentId: 'student_1' })

    expect(res.status).toBe(400)
    expect(cls.save).not.toHaveBeenCalled()
  })
})

describe('POST /api/admin/logs/seed', () => {
  const originalEnv = process.env.NODE_ENV

  afterEach(() => {
    process.env.NODE_ENV = originalEnv
  })

  it('is disabled in production', async () => {
    process.env.NODE_ENV = 'production'
    const res = await request(app).post('/api/admin/logs/seed')
    expect(res.status).toBe(403)
  })
})

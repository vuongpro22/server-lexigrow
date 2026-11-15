import { describe, it, expect, vi, beforeEach } from 'vitest'
import request from 'supertest'

/* Regression guard for the admin approvals list: it must paginate exactly like
   the other admin lists, which expose `pages` so the UI can render a pager. */

vi.mock('../src/config/db.js', () => ({ default: vi.fn().mockResolvedValue(undefined) }))

const mocks = vi.hoisted(() => ({ count: vi.fn() }))

vi.mock('../src/models/User.js', () => {
  const query = {
    populate: () => query,
    select: () => query,
    sort: () => query,
    skip: () => query,
    limit: () => query,
    then: (resolve) => resolve([]),
  }
  return {
    default: {
      findById: vi.fn(),
      find: () => query,
      updateMany: vi.fn().mockResolvedValue({ modifiedCount: 0 }),
      countDocuments: (...a) => mocks.count(...a),
    },
  }
})
vi.mock('../src/models/Class.js', () => ({ default: { updateMany: vi.fn(), findOne: vi.fn(), find: vi.fn() } }))
vi.mock('../src/models/AuditLog.js', () => ({ default: { create: vi.fn().mockResolvedValue({}) } }))
vi.mock('../src/models/Notification.js', () => ({ default: { create: vi.fn() } }))
vi.mock('../src/utils/sendEmail.js', () => ({ default: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../src/services/socket.service.js', () => ({ sendNotificationToUser: vi.fn() }))

const { default: app } = await import('../src/app.js')

describe('GET /api/admin/approvals — pagination contract', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret'
  })

  it('returns limit and pages alongside total and page', async () => {
    mocks.count.mockResolvedValue(0)
    const jwt = (await import('jsonwebtoken')).default
    const token = jwt.sign({ id: 'admin_1', role: 'admin', passwordVersion: 0 }, process.env.JWT_SECRET)
    vi.spyOn((await import('../src/models/User.js')).default, 'findById').mockImplementation(() => ({
      select: () => Promise.resolve({ _id: 'admin_1', role: 'admin', accountStatus: 'active', passwordVersion: 0 }),
      then: (resolve) => resolve({ _id: 'admin_1', role: 'admin', accountStatus: 'active', passwordVersion: 0 }),
    }))

    const res = await request(app)
      .get('/api/admin/approvals')
      .set('Cookie', 'token=' + token)

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ success: true, total: 0, page: 1, limit: 30, pages: 1 })
  })
})

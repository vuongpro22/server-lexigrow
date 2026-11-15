import { vi, describe, it, expect, beforeEach } from 'vitest'

vi.mock('../src/config/db.js', () => ({
  default: vi.fn().mockImplementation(() => Promise.resolve()),
}))

const mockFindById = vi.fn()

vi.mock('../src/models/Announcement.js', () => {
  const create = vi.fn()
  const find = vi.fn()
  const countDocuments = vi.fn()
  const model = {
    create,
    find,
    countDocuments,
    findById: (...args) => mockFindById(...args),
  }
  return { default: model }
})

vi.mock('../src/models/AuditLog.js', () => ({
  default: { create: vi.fn().mockResolvedValue({ _id: 'audit_1' }) },
}))

// Bypass auth: inject an admin and allow every role.
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
import Announcement from '../src/models/Announcement.js'
import AuditLog from '../src/models/AuditLog.js'

/* The list handler chains sort().skip().limit().populate().lean(). */
function listQueryResolving(items) {
  const lean = vi.fn().mockResolvedValue(items)
  const populate = vi.fn().mockReturnValue({ lean })
  const limit = vi.fn().mockReturnValue({ populate })
  const skip = vi.fn().mockReturnValue({ limit })
  const sort = vi.fn().mockReturnValue({ skip })
  return { sort, skip, limit }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('GET /api/admin/announcements', () => {
  it('paginates and clamps the page size', async () => {
    const query = listQueryResolving([{ _id: 'a1', title: 'One' }])
    Announcement.find.mockReturnValue(query)
    Announcement.countDocuments.mockResolvedValue(45)

    const res = await request(app).get('/api/admin/announcements?page=3&limit=20').expect(200)

    expect(res.body.success).toBe(true)
    expect(res.body.data).toHaveLength(1)
    expect(res.body.pagination).toMatchObject({ total: 45, page: 3, limit: 20, pages: 3 })
    expect(query.skip).toHaveBeenCalledWith(40)
    expect(query.limit).toHaveBeenCalledWith(20)
    expect(query.sort).toHaveBeenCalledWith({ createdAt: -1 })
  })

  it('ignores an unknown status instead of filtering everything out', async () => {
    const query = listQueryResolving([])
    Announcement.find.mockReturnValue(query)
    Announcement.countDocuments.mockResolvedValue(0)

    await request(app).get('/api/admin/announcements?status=bogus').expect(200)

    expect(Announcement.find).toHaveBeenCalledWith({})
  })

  it('filters by status when it is valid', async () => {
    const query = listQueryResolving([])
    Announcement.find.mockReturnValue(query)
    Announcement.countDocuments.mockResolvedValue(0)

    await request(app).get('/api/admin/announcements?status=draft').expect(200)

    expect(Announcement.find).toHaveBeenCalledWith({ status: 'draft' })
  })

  it('limits the published filter to the live publish/expiry window', async () => {
    const query = listQueryResolving([])
    Announcement.find.mockReturnValue(query)
    Announcement.countDocuments.mockResolvedValue(0)

    await request(app).get('/api/admin/announcements?status=published').expect(200)

    const filter = Announcement.find.mock.calls[0][0]
    expect(filter.status).toBe('published')
    expect(filter.$and).toHaveLength(2)
    expect(JSON.stringify(filter.$and)).toContain('publishAt')
    expect(JSON.stringify(filter.$and)).toContain('expiresAt')
  })

  it('escapes regex characters in the search term', async () => {
    const query = listQueryResolving([])
    Announcement.find.mockReturnValue(query)
    Announcement.countDocuments.mockResolvedValue(0)

    await request(app).get('/api/admin/announcements?search=a.b*').expect(200)

    const filter = Announcement.find.mock.calls[0][0]
    expect(filter.$or[0].title.$regex).toBe('a\\.b\\*')
  })
})

describe('POST /api/admin/announcements', () => {
  it('rejects a payload with no title or body', async () => {
    const res = await request(app).post('/api/admin/announcements').send({}).expect(400)

    expect(res.body.success).toBe(false)
    expect(res.body.message).toMatch(/title is required/)
    expect(res.body.message).toMatch(/body is required/)
    expect(Announcement.create).not.toHaveBeenCalled()
  })

  it('rejects a title longer than 160 characters', async () => {
    const res = await request(app)
      .post('/api/admin/announcements')
      .send({ title: 'x'.repeat(161), body: 'ok' })
      .expect(400)

    expect(res.body.message).toMatch(/160 characters or fewer/)
  })

  it('rejects an unknown audience', async () => {
    const res = await request(app)
      .post('/api/admin/announcements')
      .send({ title: 'Hi', body: 'Body', audience: 'everyone' })
      .expect(400)

    expect(res.body.message).toMatch(/audience must be one of/)
  })

  it('rejects expiresAt that is not after publishAt', async () => {
    const res = await request(app)
      .post('/api/admin/announcements')
      .send({
        title: 'Hi',
        body: 'Body',
        publishAt: '2026-05-10T00:00:00.000Z',
        expiresAt: '2026-05-09T00:00:00.000Z',
      })
      .expect(400)

    expect(res.body.message).toMatch(/expiresAt must be after publishAt/)
    expect(Announcement.create).not.toHaveBeenCalled()
  })

  it('trims text and defaults the enums, then records an audit entry', async () => {
    Announcement.create.mockImplementation((doc) =>
      Promise.resolve({ _id: 'a_new', ...doc }))

    const res = await request(app)
      .post('/api/admin/announcements')
      .send({ title: '  Term break  ', body: '  Classes resume Monday.  ' })
      .expect(201)

    expect(Announcement.create).toHaveBeenCalledWith({
      title: 'Term break',
      body: 'Classes resume Monday.',
      createdBy: 'admin_1',
    })
    expect(res.body.data.title).toBe('Term break')

    expect(AuditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      user: 'admin_1',
      action: 'announcement.create',
      targetType: 'Announcement',
      targetId: 'a_new',
    }))
  })

  it('still returns 201 when writing the audit entry fails', async () => {
    Announcement.create.mockResolvedValue({ _id: 'a_new', title: 'Hi' })
    AuditLog.create.mockRejectedValueOnce(new Error('audit down'))

    const res = await request(app)
      .post('/api/admin/announcements')
      .send({ title: 'Hi', body: 'Body' })
      .expect(201)

    expect(res.body.success).toBe(true)
  })
})

describe('PATCH /api/admin/announcements/:id', () => {
  it('returns 404 for an unknown id', async () => {
    mockFindById.mockResolvedValue(null)

    await request(app).patch('/api/admin/announcements/missing').send({ title: 'x' }).expect(404)
  })

  it('validates only the supplied fields', async () => {
    mockFindById.mockResolvedValue({ _id: 'a1', title: 'Old', body: 'Old body', save: vi.fn() })

    await request(app).patch('/api/admin/announcements/a1').send({ status: 'nope' }).expect(400)
  })

  it('rejects a date window that ends before it starts when merged with stored values', async () => {
    mockFindById.mockResolvedValue({
      _id: 'a1',
      title: 'Old',
      body: 'Old body',
      publishAt: new Date('2026-05-10T00:00:00.000Z'),
      expiresAt: null,
      save: vi.fn(),
    })

    const res = await request(app)
      .patch('/api/admin/announcements/a1')
      .send({ expiresAt: '2026-05-09T00:00:00.000Z' })
      .expect(400)

    expect(res.body.message).toMatch(/expiresAt must be after publishAt/)
  })

  it('applies the patch and stamps updatedBy', async () => {
    const save = vi.fn().mockResolvedValue(undefined)
    const stored = { _id: 'a1', title: 'Old', body: 'Old body', save }
    mockFindById.mockResolvedValue(stored)

    const res = await request(app)
      .patch('/api/admin/announcements/a1')
      .send({ title: 'New' })
      .expect(200)

    expect(stored.title).toBe('New')
    expect(stored.updatedBy).toBe('admin_1')
    expect(save).toHaveBeenCalled()
    expect(res.body.data.title).toBe('New')
    expect(AuditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      action: 'announcement.update',
      targetId: 'a1',
    }))
  })
})

describe('DELETE /api/admin/announcements/:id', () => {
  it('returns 404 for an unknown id', async () => {
    mockFindById.mockResolvedValue(null)

    await request(app).delete('/api/admin/announcements/missing').expect(404)
  })

  it('deletes the record and records an audit entry', async () => {
    const deleteOne = vi.fn().mockResolvedValue(undefined)
    mockFindById.mockResolvedValue({ _id: 'a1', title: 'Gone', deleteOne })

    const res = await request(app).delete('/api/admin/announcements/a1').expect(200)

    expect(deleteOne).toHaveBeenCalled()
    expect(res.body.success).toBe(true)
    expect(AuditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      action: 'announcement.delete',
      targetId: 'a1',
    }))
  })
})

describe('GET /api/admin/announcements/stats', () => {
  it('counts each status bucket', async () => {
    Announcement.countDocuments
      .mockResolvedValueOnce(9) // total
      .mockResolvedValueOnce(5) // published
      .mockResolvedValueOnce(3) // draft
      .mockResolvedValueOnce(1) // archived

    const res = await request(app).get('/api/admin/announcements/stats').expect(200)

    expect(res.body.data).toEqual({ total: 9, published: 5, draft: 3, archived: 1 })
  })
})

import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'

const mocks = vi.hoisted(() => ({
  classFind: vi.fn(),
  userFind: vi.fn(),
  userCount: vi.fn(),
  chain: null,
}))

// Records every cursor call so a test can assert the query ran paged in Mongo.
function cursor(result) {
  const calls = []
  const api = {
    calls,
    select: (...a) => { calls.push(['select', ...a]); return api },
    sort: (...a) => { calls.push(['sort', ...a]); return api },
    skip: (...a) => { calls.push(['skip', ...a]); return api },
    limit: (...a) => { calls.push(['limit', ...a]); return api },
    lean: async () => result,
  }
  mocks.chain = api
  return api
}

vi.mock('../src/models/Class.js', () => ({
  default: { find: (...a) => mocks.classFind(...a) },
}))

vi.mock('../src/models/User.js', () => ({
  default: {
    find: (...a) => mocks.userFind(...a),
    countDocuments: (...a) => mocks.userCount(...a),
  },
}))

vi.mock('../src/controllers/chat.controller.js', () => ({
  getChatHistory: (req, res) => res.json({ ok: true }),
  sendMessage: (req, res) => res.json({ ok: true }),
  getChatRooms: (req, res) => res.json({ ok: true }),
  markRoomRead: (req, res) => res.json({ ok: true }),
}))

vi.mock('../src/middleware/auth.middleware.js', () => ({
  protect: (req, res, next) => {
    req.user = { _id: req.headers['x-user'] || 'admin_1', role: req.headers['x-role'] || 'admin' }
    next()
  },
  authorize: (...roles) => (req, res, next) => (
    roles.includes(req.user.role) ? next() : res.status(403).json({ success: false })
  ),
}))

const { default: classRoutes } = await import('../src/routes/class.routes.js')
const { default: chatRoutes } = await import('../src/routes/chat.routes.js')
const { foldedSearchRegex, filterByFoldedText } = await import('../src/utils/foldDiacritics.js')

const app = express()
app.use(express.json())
app.use('/api/classes', classRoutes)
app.use('/api/chat', chatRoutes)
// Express only treats a 4-argument function as an error handler.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => res.status(err.statusCode || 500).json({ error: err.message }))

beforeEach(() => {
  vi.clearAllMocks()
  mocks.classFind.mockImplementation(() => cursor([{ _id: 'c1', name: 'Lớp A' }]))
  mocks.userFind.mockImplementation(() => cursor([{ _id: 'u1', name: 'Phạm Minh Quân' }]))
  mocks.userCount.mockResolvedValue(42)
})

describe('admin class routes share the admin rate limit', () => {
  it('sends RateLimit headers on /api/classes/admin/* and /api/chat/rooms', async () => {
    for (const path of ['/api/classes/admin/options', '/api/classes/admin/users?role=student', '/api/chat/rooms']) {
      const res = await request(app).get(path).set('x-user', 'limit-probe')
      expect(res.status, path).toBe(200)
      expect(res.headers['ratelimit-limit'], path).toBe('300')
    }
  })

  it('still refuses non-admins on every /api/classes/admin path', async () => {
    for (const path of ['/api/classes/admin', '/api/classes/admin/options', '/api/classes/admin/c1']) {
      await request(app).get(path).set('x-role', 'teacher').expect(403)
    }
    await request(app).post('/api/classes/admin/transfer').set('x-role', 'teacher').send({}).expect(403)
  })

  it('leaves the non-admin chat routes outside the admin limit', async () => {
    const res = await request(app).get('/api/chat/history/room_1').set('x-role', 'student')
    expect(res.headers['ratelimit-limit']).toBeUndefined()
  })
})

describe('admin pickers search inside MongoDB', () => {
  it('pages users in the query instead of loading the whole role', async () => {
    const res = await request(app).get('/api/classes/admin/users?role=student&search=pham&page=3&limit=10')

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ total: 42, page: 3, pages: 5, count: 1 })
    const [filter] = mocks.userFind.mock.calls[0]
    expect(filter.role).toBe('student')
    expect(filter.accountStatus).toBe('active')
    expect(filter.$or.map((clause) => Object.keys(clause)[0])).toEqual(['name', 'email'])
    expect(filter.$or[0].name.test('Phạm Minh Quân')).toBe(true)
    expect(mocks.chain.calls).toEqual(expect.arrayContaining([['skip', 20], ['limit', 10]]))
    expect(mocks.userCount).toHaveBeenCalledWith(filter)
  })

  it('omits the search clause when the query is blank', async () => {
    await request(app).get('/api/classes/admin/users?role=teacher&search=%20%20').expect(200)
    const [filter] = mocks.userFind.mock.calls[0]
    expect(filter).toEqual({ role: 'teacher', accountStatus: 'active' })
  })

  it('limits class options to 30 active classes matched in the query', async () => {
    await request(app).get('/api/classes/admin/options?search=lop').expect(200)
    const [filter] = mocks.classFind.mock.calls[0]
    expect(filter.status).toBe('active')
    expect(filter.name.test('Lớp B')).toBe(true)
    expect(filter.name.test('Toán')).toBe(false)
    expect(mocks.chain.calls).toEqual(expect.arrayContaining([['limit', 30]]))
  })
})

describe('foldedSearchRegex matches exactly what filterByFoldedText keeps', () => {
  const names = [
    'Phạm Minh Quân', 'PHẠM VĂN ĐỨC', 'Tô Đình Văn', 'Cô Tuyết Minh', 'Lớp A', 'lop a',
    'Nguyễn Thị Ánh', 'Ångström', 'a.b+c (x)', 'quanpm@fpt.edu.vn', 'Ưu tiên', 'Ở đây',
    'Phạm'.normalize('NFD'), 'Đặng'.normalize('NFD'), '[test]*', 'Hồ Chí Minh',
  ].map((name) => ({ name }))
  const queries = [
    'pha', 'PHAM', 'phạm', 'dinh', 'Đình', 'duc', 'lop a', 'Lớp', 'anh', 'ánh', 'ang', 'a.b',
    '(x', '+c', '@fpt', 'uu', 'ư', 'o d', 'dang', '[t', '*', 'ho chi', 'z', 'ạ', 'Q', '',
  ]

  it.each(queries)('query %j', (query) => {
    const regex = foldedSearchRegex(query)
    const viaRegex = regex ? names.filter((doc) => regex.test(doc.name)) : names
    expect(viaRegex).toEqual(filterByFoldedText(names, query, ['name']))
  })

  it('escapes regex syntax so a crafted search cannot backtrack', () => {
    const regex = foldedSearchRegex('(a+)+$')
    expect(regex.test('(a+)+$')).toBe(true)
    expect(regex.test('aaaaaaaaaaaaaaaaaaaaaaaa!')).toBe(false)
  })
})

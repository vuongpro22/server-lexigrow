import { vi, describe, it, expect, beforeEach } from 'vitest'

vi.mock('../src/config/db.js', () => ({
  default: vi.fn().mockImplementation(() => Promise.resolve()),
}))

vi.mock('../src/models/Announcement.js', () => {
  const aggregate = vi.fn().mockResolvedValue([])
  return { default: { aggregate, __aggregate: aggregate } }
})

vi.mock('../src/models/Notification.js', () => ({ default: { find: vi.fn(), countDocuments: vi.fn() } }))
vi.mock('../src/models/ParentStudentLink.js', () => ({ default: { findOne: vi.fn() } }))
vi.mock('../src/services/parentLink.service.js', () => ({ activateParentStudentLink: vi.fn() }))
vi.mock('../src/services/socket.service.js', () => ({ syncParentLinkedRooms: vi.fn() }))
vi.mock('../src/models/User.js', () => ({ default: { findById: vi.fn() } }))
vi.mock('../src/utils/sendEmail.js', () => ({ default: vi.fn() }))

// Tokens are covered by their own suite; here only "signed in" vs "guest" matters.
vi.mock('../src/middleware/auth.middleware.js', () => ({
  protect: (req, res, next) => {
    req.user = { _id: 'user_1', role: 'teacher' }
    next()
  },
  authorize: () => (req, res, next) => next(),
  optionalAuth: (req, res, next) => {
    if (req.headers.authorization === 'Bearer student-token') {
      req.user = { _id: 'student_1', role: 'student' }
    }
    next()
  },
}))

import request from 'supertest'
import app from '../src/index.js'
import Announcement from '../src/models/Announcement.js'

const matchStage = () => Announcement.aggregate.mock.calls[0][0][0].$match
const audiencesFor = () => matchStage().audience.$in

beforeEach(() => {
  vi.clearAllMocks()
  Announcement.__aggregate.mockResolvedValue([])
})

describe('GET /api/notifications/announcements', () => {
  it('serves the "all" audience to a visitor who has not signed up', async () => {
    const res = await request(app).get('/api/notifications/announcements').expect(200)

    expect(res.body.success).toBe(true)
    expect(audiencesFor()).toEqual(['all'])
  })

  it('adds the signed-in role to the audience filter', async () => {
    await request(app)
      .get('/api/notifications/announcements')
      .set('Authorization', 'Bearer student-token')
      .expect(200)

    expect(audiencesFor()).toEqual(['all', 'student'])
  })

  it('only returns live announcements inside the publish and expiry window', async () => {
    await request(app).get('/api/notifications/announcements').expect(200)

    const filter = matchStage()
    expect(filter.status).toBe('published')
    expect(filter.$and).toHaveLength(2)
    expect(JSON.stringify(filter.$and)).toContain('publishAt')
    expect(JSON.stringify(filter.$and)).toContain('expiresAt')
  })

  it('returns the announcement rows', async () => {
    Announcement.__aggregate.mockResolvedValue([
      { _id: 'a1', title: 'Term break', body: 'Resume Monday', priority: 'important' },
    ])

    const res = await request(app).get('/api/notifications/announcements').expect(200)

    expect(res.body.data).toHaveLength(1)
    expect(res.body.data[0].title).toBe('Term break')
  })

  it('ranks critical above important and normal announcements', async () => {
    await request(app).get('/api/notifications/announcements').expect(200)

    const pipeline = Announcement.aggregate.mock.calls[0][0]
    expect(pipeline[1].$addFields.priorityRank.$switch.branches).toEqual([
      { case: { $eq: ['$priority', 'critical'] }, then: 0 },
      { case: { $eq: ['$priority', 'important'] }, then: 1 },
    ])
    expect(pipeline[2]).toEqual({ $sort: { priorityRank: 1, createdAt: -1 } })
  })
})

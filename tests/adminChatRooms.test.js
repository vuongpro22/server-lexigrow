import { describe, it, expect, vi, beforeEach } from 'vitest'

/* The admin support inbox reads this endpoint. Two properties matter and are
   easy to regress: the room list is capped, and owners are resolved with one
   query instead of a findById per room. */

const ChatMessage = { aggregate: vi.fn() }
const User = { find: vi.fn(), findById: vi.fn() }

vi.mock('../src/models/ChatMessage.js', () => ({ default: ChatMessage }))
vi.mock('../src/models/User.js', () => ({ default: User }))
vi.mock('../src/services/socket.service.js', () => ({ getIO: () => ({ to: () => ({ emit: vi.fn() }) }) }))
vi.mock('../src/utils/essayAccess.js', () => ({ canAccessChatRoom: vi.fn().mockResolvedValue(true) }))

const { getChatRooms } = await import('../src/controllers/chat.controller.js')

const mockRes = () => ({ status: vi.fn().mockReturnThis(), json: vi.fn() })
const aggregateResult = (rooms = [], stats = []) => [{ rooms, stats }]

// Room ids embed a user id, and the controller filters out anything that is not a
// real ObjectId, so the fixtures must use valid hex ids.
const U1 = '507f1f77bcf86cd799439011'
const U2 = '507f1f77bcf86cd799439012'

// User.find is called twice: distinct ad ids (with .distinct) and the owner batch.
const adminDistinct = { distinct: vi.fn().mockResolvedValue(['admin_id']) }
const ownerLean = { select: vi.fn().mockReturnThis(), lean: vi.fn().mockResolvedValue([
  { _id: U1, name: 'An', email: 'an@example.com', role: 'student' },
  { _id: U2, name: 'Binh', email: 'binh@example.com', role: 'teacher' },
]) }
User.find.mockReturnValue(adminDistinct)
User.find.mockImplementation(() => adminDistinct)

beforeEach(() => {
  vi.clearAllMocks()
  User.find.mockReturnValue(adminDistinct)
})

describe('getChatRooms — bounded list and batched owners', () => {
  it('adds a $limit stage and no longer looks owners up one by one', async () => {
    let ownerCall = 0
    User.find.mockImplementation(() => {
      ownerCall += 1
      return ownerCall === 1 ? adminDistinct : ownerLean
    })
    ChatMessage.aggregate.mockResolvedValue(aggregateResult([
      { _id: 'user:' + U1, lastMessageAt: new Date('2026-01-02'), unreadCount: 2, totalMessages: 5 },
      { _id: 'user:' + U2, lastMessageAt: new Date('2026-01-01'), unreadCount: 0, totalMessages: 1 },
      { _id: 'support', lastMessageAt: new Date('2026-01-01'), unreadCount: 0, totalMessages: 3 },
    ], [{ totalRooms: 203, privateRooms: 202, unreadMessages: 24 }]))

    const res = mockRes()
    await getChatRooms({ user: { role: 'admin' }, query: {} }, res, vi.fn())

    const pipeline = ChatMessage.aggregate.mock.calls[0][0]
    expect(pipeline.some((stage) => '$facet' in stage)).toBe(true)
    const facet = pipeline.find((stage) => '$facet' in stage).$facet
    expect(facet.rooms.at(-1)).toEqual({ $limit: 200 })
    expect(facet.stats.find((stage) => '$group' in stage).$group).toMatchObject({
      totalRooms: { $sum: 1 },
      unreadMessages: { $sum: '$unreadCount' },
    })
    expect(User.findById).not.toHaveBeenCalled()
    expect(res.json.mock.calls[0][0].stats).toEqual({ totalRooms: 203, privateRooms: 202, unreadMessages: 24 })
    expect(res.json.mock.calls[0][0].data).toEqual([
      expect.objectContaining({ room: 'user:' + U1, roomType: 'private', user: expect.objectContaining({ name: 'An' }) }),
      expect.objectContaining({ room: 'user:' + U2, roomType: 'private', user: expect.objectContaining({ name: 'Binh' }) }),
      expect.objectContaining({ room: 'support', roomType: 'support', user: null }),
    ])
  })

  it('clamps a hostile limit and ignores a non-numeric one', async () => {
    ChatMessage.aggregate.mockResolvedValue(aggregateResult())
    await getChatRooms({ user: { role: 'admin' }, query: { limit: '999999' } }, mockRes(), vi.fn())
    let pipeline = ChatMessage.aggregate.mock.calls[0][0]
    expect(pipeline.find((stage) => '$facet' in stage).$facet.rooms.at(-1).$limit).toBe(500)

    ChatMessage.aggregate.mockClear()
    await getChatRooms({ user: { role: 'admin' }, query: { limit: 'abc' } }, mockRes(), vi.fn())
    pipeline = ChatMessage.aggregate.mock.calls[0][0]
    expect(pipeline.find((stage) => '$facet' in stage).$facet.rooms.at(-1).$limit).toBe(200)
  })

  it('returns zero global stats when no chat messages exist', async () => {
    ChatMessage.aggregate.mockResolvedValue(aggregateResult())
    const res = mockRes()

    await getChatRooms({ user: { role: 'admin' }, query: {} }, res, vi.fn())

    expect(res.json.mock.calls[0][0].stats).toEqual({ totalRooms: 0, privateRooms: 0, unreadMessages: 0 })
  })

  it('still refuses non-admin callers', async () => {
    const next = vi.fn()
    await getChatRooms({ user: { role: 'student' }, query: {} }, mockRes(), next)
    expect(ChatMessage.aggregate).not.toHaveBeenCalled()
    expect(next.mock.calls[0][0].statusCode).toBe(403)
  })
})

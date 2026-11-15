import { beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'

const { mockUser, findOneMock } = vi.hoisted(() => {
  const findOne = vi.fn()
  return {
    findOneMock: findOne,
    mockUser: {
      _id: '65f999888777666555444333',
      name: 'Operator Injection Target',
      email: 'admin@lexigrow.com',
      role: 'admin',
      accountStatus: 'active',
      matchPassword: vi.fn().mockResolvedValue(true),
      select: vi.fn().mockReturnThis(),
      toObject() {
        return { _id: this._id, name: this.name, email: this.email, role: this.role, accountStatus: this.accountStatus }
      },
    },
  }
})

vi.mock('../src/config/db.js', () => ({
  default: vi.fn().mockResolvedValue(),
}))

vi.mock('../src/models/User.js', () => ({
  default: {
    findOne: findOneMock,
    findById: vi.fn().mockResolvedValue(null),
  },
}))

vi.mock('../src/models/PendingUser.js', () => ({
  default: {
    findOne: findOneMock,
    findOneAndDelete: vi.fn().mockResolvedValue(null),
    deleteMany: vi.fn().mockResolvedValue({}),
    create: vi.fn().mockResolvedValue({}),
  },
}))

import app from '../src/index.js'

describe('Auth rejects NoSQL operator injection in public body fields', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    findOneMock.mockResolvedValue(null)
  })

  it('login rejects an email object instead of querying with it', async () => {
    findOneMock.mockReturnValue({ select: vi.fn().mockResolvedValue(mockUser) })

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: { $ne: null }, password: 'anything' })

    expect(res.status).toBe(400)
    expect(res.body.success).toBe(false)
    expect(findOneMock).not.toHaveBeenCalled()
  })

  it('login still accepts a normal string email', async () => {
    findOneMock.mockReturnValue({ select: vi.fn().mockResolvedValue(mockUser) })

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'admin@lexigrow.com', password: '123456' })

    expect(res.status).toBe(200)
    expect(findOneMock).toHaveBeenCalledWith({ email: 'admin@lexigrow.com' })
  })

  it('forgot-password rejects an email object', async () => {
    const res = await request(app)
      .post('/api/auth/forgot-password')
      .send({ email: { $ne: null } })

    expect(res.status).toBe(400)
    expect(findOneMock).not.toHaveBeenCalled()
  })

  it('check-email rejects an email object', async () => {
    const res = await request(app)
      .post('/api/auth/check-email')
      .send({ email: { $gt: '' } })

    expect(res.status).toBe(400)
    expect(findOneMock).not.toHaveBeenCalled()
  })

  it('register rejects a non-string password', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ name: 'X', email: 'x@example.com', password: { $ne: null } })

    expect(res.status).toBe(400)
    expect(findOneMock).not.toHaveBeenCalled()
  })

  // Regression: reset-password accepted operator objects, so
  // {"email":{"$ne":null},"code":{"$ne":""}} matched any user mid-reset and
  // rewrote their password without knowing the code.
  it('reset-password rejects operator objects instead of querying with them', async () => {
    const res = await request(app)
      .post('/api/auth/reset-password')
      .send({ email: { $ne: null }, code: { $ne: '' }, newPassword: 'pwned12345' })

    expect(res.status).toBe(400)
    expect(findOneMock).not.toHaveBeenCalled()
  })

  it('reset-password rejects a non-string code even with a valid email', async () => {
    const res = await request(app)
      .post('/api/auth/reset-password')
      .send({ email: 'admin@lexigrow.com', code: 123456, newPassword: 'abcdef' })

    expect(res.status).toBe(400)
    expect(findOneMock).not.toHaveBeenCalled()
  })
})

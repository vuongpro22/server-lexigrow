import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'

const mocks = vi.hoisted(() => ({ findOne: vi.fn(), create: vi.fn(), getToken: vi.fn(), verifyIdToken: vi.fn() }))
vi.mock('../src/models/User.js', () => ({ default: { findOne: mocks.findOne, create: mocks.create } }))
vi.mock('google-auth-library', () => ({ OAuth2Client: class {
  getToken(...args) { return mocks.getToken(...args) }
  verifyIdToken(...args) { return mocks.verifyIdToken(...args) }
} }))
import { googleAuth } from '../src/controllers/auth.controller.js'

const app = express()
app.use(express.json())
app.post('/api/auth/google', googleAuth)
app.use((err, req, res, next) => {
  void next
  res.status(err.statusCode || 500).json({ message: err.message })
})

describe('Google teacher approval', () => {
  afterEach(() => vi.unstubAllEnvs())
  beforeEach(() => {
    vi.resetAllMocks()
    vi.stubEnv('GOOGLE_CLIENT_ID', 'test-client')
    vi.stubEnv('GOOGLE_CLIENT_SECRET', 'test-secret')
    vi.stubEnv('JWT_SECRET', 'test-jwt-secret')
    mocks.getToken.mockResolvedValue({ tokens: { id_token: 'verified-token' } })
    mocks.verifyIdToken.mockResolvedValue({ getPayload: () => ({ sub: 'google-user', email: 'teacher@example.test', name: 'Teacher' }) })
    mocks.findOne.mockResolvedValue(null)
    mocks.create.mockImplementation(async fields => ({ ...fields, _id: 'test-user', toObject() { return { ...fields } } }))
  })

  it('creates a pending teacher without issuing a session', async () => {
    const res = await request(app).post('/api/auth/google').send({ code: 'code', role: 'teacher' })
    expect(res.status).toBe(202)
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ role: 'teacher', accountStatus: 'pending_approval', isVerified: true }))
    expect(res.body.pendingApproval).toBe(true)
    expect(res.body.user).toBeUndefined()
    expect(res.body.token).toBeUndefined()
    expect(res.headers['set-cookie']).toBeUndefined()
  })

  it('normalizes Google email before matching an existing account', async () => {
    mocks.verifyIdToken.mockResolvedValue({ getPayload: () => ({ sub: 'google-user', email: '  Teacher@Example.TEST  ', name: 'Teacher' }) })
    mocks.findOne.mockResolvedValue({ role: 'teacher', accountStatus: 'pending_approval' })
    await request(app).post('/api/auth/google').send({ code: 'code' }).expect(202)
    expect(mocks.findOne).toHaveBeenCalledWith({ $or: [{ googleId: 'google-user' }, { email: 'teacher@example.test' }] })
    expect(mocks.create).not.toHaveBeenCalled()
  })

  it('keeps returning pending on a repeat Google sign-in', async () => {
    mocks.findOne.mockResolvedValue({ role: 'teacher', accountStatus: 'pending_approval' })
    const res = await request(app).post('/api/auth/google').send({ code: 'code' })
    expect(res.status).toBe(202)
    expect(res.body.pendingApproval).toBe(true)
    expect(res.headers['set-cookie']).toBeUndefined()
    expect(mocks.create).not.toHaveBeenCalled()
  })

  it.each(['suspended', 'rejected', 'deleted'])('blocks %s accounts', async accountStatus => {
    mocks.findOne.mockResolvedValue({ role: 'teacher', accountStatus })
    const res = await request(app).post('/api/auth/google').send({ code: 'code' })
    expect(res.status).toBe(403)
    expect(res.headers['set-cookie']).toBeUndefined()
  })

  it.each(['student', 'parent'])('still signs in a new %s', async role => {
    const res = await request(app).post('/api/auth/google').send({ code: 'code', role })
    expect(res.status).toBe(200)
    expect(res.headers['set-cookie']).toBeDefined()
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ role, accountStatus: 'active' }))
  })

  it('allows an approved teacher to sign in', async () => {
    mocks.findOne.mockResolvedValue({ _id: 'approved-teacher', role: 'teacher', googleId: 'google-user', accountStatus: 'active', toObject: () => ({ role: 'teacher' }) })
    const res = await request(app).post('/api/auth/google').send({ code: 'code' })
    expect(res.status).toBe(200)
    expect(res.headers['set-cookie']).toBeDefined()
  })
})

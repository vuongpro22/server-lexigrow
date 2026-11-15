import { beforeAll, afterAll, beforeEach, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import mongoose from 'mongoose'
import { MongoMemoryServer } from 'mongodb-memory-server'
vi.mock('../src/utils/sendEmail.js', () => ({ default: vi.fn().mockResolvedValue({}) }))
import sendEmail from '../src/utils/sendEmail.js'
import User from '../src/models/User.js'
import { updateProfile, confirmEmailChange } from '../src/controllers/profile.controller.js'
import { emailChangeRequestLimiter, emailChangeVerifyLimiter } from '../src/middleware/rateLimit.middleware.js'

let mongo, user
const app = express()
app.use(express.json())
app.use((req, res, next) => { req.user = { _id: user._id, email: user.email }; next() })
app.put('/profile', emailChangeRequestLimiter, updateProfile)
app.post('/confirm', emailChangeVerifyLimiter, confirmEmailChange)
app.use((error, req, res, next) => { void next; res.status(error.statusCode || 500).json({ message: error.message }) })
const password = 'Password123!'
const start = (body = {}) => request(app).put('/profile').send({ email: ' NEW@Example.test ', currentPassword: password, ...body })
const code = () => sendEmail.mock.calls.find(([mail]) => mail.email === 'new@example.test')[0].message.match(/\b\d{6}\b/)[0]

beforeAll(async () => {
  mongo = await MongoMemoryServer.create()
  await mongoose.connect(mongo.getUri())
  await User.init()
}, 60000)
afterAll(async () => { await mongoose.disconnect(); await mongo?.stop() })
beforeEach(async () => {
  vi.restoreAllMocks()
  sendEmail.mockReset().mockResolvedValue({})
  await User.deleteMany({})
  user = await User.create({ name: 'User', email: 'old@example.test', password, role: 'teacher', googleId: 'old-google' })
})

it('requires the current password and keeps the email unchanged until confirmation', async () => {
  await start({ currentPassword: '' }).expect(400)
  await start({ currentPassword: 'wrong-password' }).expect(401)
  expect(sendEmail).not.toHaveBeenCalled()
  expect((await User.findById(user._id)).email).toBe(user.email)
})

it('verifies a hashed one-time code, updates email once, detaches old Google identity and warns the old address', async () => {
  const response = await start().expect(202)
  expect(response.body.data.email).toBe(user.email)
  expect(response.body.pendingEmail).toBe('new@example.test')
  expect(response.body.data.emailChange).toBeUndefined()
  const stored = await User.findById(user._id).select('+emailChange')
  expect(stored.emailChange.codeHash).not.toBe(code())
  expect((await User.findById(user._id)).emailChange).toBeUndefined()
  const confirmed = await request(app).post('/confirm').send({ code: code() }).expect(200)
  expect(confirmed.body.data.email).toBe('new@example.test')
  expect(confirmed.body.data.password).toBeUndefined()
  expect(confirmed.body.data.emailChange).toBeUndefined()
  expect(confirmed.body.data.googleId).toBe('')
  expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({ email: 'old@example.test', subject: expect.stringContaining('Cảnh báo') }))
  await request(app).post('/confirm').send({ code: code() }).expect(400)
})

it('returns 409 for an email owned by someone else', async () => {
  await User.create({ name: 'Other', email: 'new@example.test', password })
  await start().expect(409)
  expect(sendEmail).not.toHaveBeenCalled()
})

it('returns 409 when the destination is claimed between request and confirmation', async () => {
  await start().expect(202)
  await User.create({ name: 'Other', email: 'new@example.test', password })
  await request(app).post('/confirm').send({ code: code() }).expect(409)
  expect((await User.findById(user._id)).email).toBe(user.email)
})

it('rejects incorrect and expired codes', async () => {
  await start().expect(202)
  const wrong = code() === '123456' ? '654321' : '123456'
  await request(app).post('/confirm').send({ code: wrong }).expect(400)
  await User.updateOne({ _id: user._id }, { $set: { 'emailChange.expiresAt': new Date(0) } })
  await request(app).post('/confirm').send({ code: code() }).expect(400)
})

it('invalidates a request after the account password changes', async () => {
  await start().expect(202)
  user.password = 'ChangedPassword123!'
  await user.save()
  await request(app).post('/confirm').send({ code: code() }).expect(400)
})

it('cleans up an undelivered verification request and reports 503', async () => {
  sendEmail.mockRejectedValueOnce(new Error('SMTP down'))
  await start().expect(503)
  const stored = await User.findById(user._id).select('+emailChange')
  expect(stored.email).toBe(user.email)
  expect(stored.emailChange).toBeUndefined()
})

it('allows unchanged normalized email and ordinary profile edits without a password', async () => {
  await request(app).put('/profile').send({ email: ' OLD@Example.TEST ', name: 'Updated' }).expect(200)
  expect(sendEmail).not.toHaveBeenCalled()
  expect((await User.findById(user._id)).name).toBe('Updated')
})

it('consumes a code atomically when two confirmations arrive simultaneously', async () => {
  await start().expect(202)
  const responses = await Promise.all([0, 1].map(() => request(app).post('/confirm').send({ code: code() })))
  expect(responses.filter(res => res.status === 200)).toHaveLength(1)
  expect(responses.filter(res => [400, 409].includes(res.status))).toHaveLength(1)
})

it('rejects invalid email input before saving', async () => {
  for (const email of ['  ', 'not-an-email', { $ne: null }]) await start({ email }).expect(400)
  expect((await User.findById(user._id)).email).toBe(user.email)
})

it('limits repeated password and OTP guesses by account', async () => {
  for (let i = 0; i < 5; i++) await start({ currentPassword: 'wrong-password' }).expect(401)
  await start({ currentPassword: 'wrong-password' }).expect(429)
  for (let i = 0; i < 10; i++) await request(app).post('/confirm').send({ code: '123456' }).expect(400)
  await request(app).post('/confirm').send({ code: '123456' }).expect(429)
})

it('does not allow another account to confirm the owner’s email change', async () => {
  await start().expect(202)
  const owner = user
  user = await User.create({ name: 'Other', email: 'other@example.test', password })
  await request(app).post('/confirm').send({ code: code() }).expect(400)
  expect((await User.findById(owner._id)).email).toBe('old@example.test')
})

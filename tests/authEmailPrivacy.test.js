import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'

const mocks = vi.hoisted(() => ({ findOne: vi.fn(), updateOne: vi.fn(), sendEmail: vi.fn() }))
vi.mock('../src/models/User.js', () => ({ default: { findOne: mocks.findOne, updateOne: mocks.updateOne } }))
vi.mock('../src/utils/sendEmail.js', () => ({ default: mocks.sendEmail }))
import { forgotPassword, checkEmail } from '../src/controllers/auth.controller.js'
import { publicEmailLimiter } from '../src/middleware/rateLimit.middleware.js'

const app = express()
app.use(express.json())
app.post('/forgot', forgotPassword)
app.post('/check', checkEmail)
app.post('/limited-check', publicEmailLimiter, checkEmail)
app.use((err, req, res, next) => { void next; res.status(err.statusCode || 500).json({ message: err.message }) })
const knownUser = () => ({ _id: 'user-1', email: 'known@example.test', save: vi.fn().mockResolvedValue() })
const email = 'known@example.test'

beforeEach(() => {
  vi.resetAllMocks()
  mocks.findOne.mockResolvedValue(null)
  mocks.sendEmail.mockResolvedValue({})
  mocks.updateOne.mockResolvedValue({ modifiedCount: 1 })
})

describe('AUTH-10 public email privacy', () => {
  it('returns exactly the same status and body for known and unknown forgot-password addresses', async () => {
    const unknown = await request(app).post('/forgot').send({ email }).expect(200)
    const user = knownUser()
    mocks.findOne.mockResolvedValue(user)
    const known = await request(app).post('/forgot').send({ email }).expect(200)
    expect(known.body).toEqual(unknown.body)
    expect(Object.keys(known.body).sort()).toEqual(['message', 'success'])
    expect(mocks.sendEmail).toHaveBeenCalledTimes(1)
    expect(user.resetPasswordCode).toMatch(/^\d{6}$/)
    expect(known.body.message).not.toContain(user.resetPasswordCode)
  })

  it('keeps SMTP failure private and clears only the failed request’s code', async () => {
    const unknown = await request(app).post('/forgot').send({ email }).expect(200)
    const user = knownUser()
    mocks.findOne.mockResolvedValue(user)
    mocks.sendEmail.mockRejectedValueOnce(new Error('Sensitive SMTP failure'))
    const failed = await request(app).post('/forgot').send({ email }).expect(200)
    expect(failed.body).toEqual(unknown.body)
    await vi.waitFor(() => expect(mocks.updateOne).toHaveBeenCalledWith(
      { _id: user._id, resetPasswordCode: user.resetPasswordCode },
      { $unset: { resetPasswordCode: 1, resetPasswordExpire: 1 } },
    ))
  })

  it('does not wait for SMTP delivery before responding', async () => {
    mocks.findOne.mockResolvedValue(knownUser())
    let finish
    mocks.sendEmail.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    try {
      const response = await request(app).post('/forgot').send({ email }).expect(200)
      expect(response.body.success).toBe(true)
      expect(finish).toBeTypeOf('function')
    } finally { finish?.() }
  })

  it('returns the same acknowledgement if a reset request cannot be persisted', async () => {
    const unknown = await request(app).post('/forgot').send({ email }).expect(200)
    const user = knownUser()
    user.save.mockRejectedValueOnce(new Error('DB write failed'))
    mocks.findOne.mockResolvedValue(user)
    const failed = await request(app).post('/forgot').send({ email }).expect(200)
    expect(failed.body).toEqual(unknown.body)
    expect(mocks.sendEmail).not.toHaveBeenCalled()
  })

  it('check-email does not look up accounts or expose existence', async () => {
    mocks.findOne.mockResolvedValue(knownUser())
    const known = await request(app).post('/check').send({ email }).expect(200)
    const unknown = await request(app).post('/check').send({ email: 'unknown@example.test' }).expect(200)
    expect(known.body).toEqual(unknown.body)
    expect(known.body.exists).toBeUndefined()
    expect(mocks.findOne).not.toHaveBeenCalled()
  })

  it.each(['/check', '/forgot'])('%s rejects malformed email input without querying', async endpoint => {
    for (const value of [' ', null, { $ne: null }]) await request(app).post(endpoint).send({ email: value }).expect(400)
    expect(mocks.findOne).not.toHaveBeenCalled()
  })

  it('rate-limits probing many distinct emails from one IP', async () => {
    for (let i = 0; i < 30; i++) await request(app).post('/limited-check').send({ email: `probe${i}@example.test` }).expect(200)
    await request(app).post('/limited-check').send({ email: 'another@example.test' }).expect(429)
  })
})

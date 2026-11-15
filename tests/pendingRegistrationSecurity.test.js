import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import mongoose from 'mongoose'
import bcrypt from 'bcryptjs'
import { MongoMemoryServer } from 'mongodb-memory-server'

vi.mock('../src/utils/sendEmail.js', () => ({ default: vi.fn().mockResolvedValue({}) }))
vi.mock('node:crypto', async importOriginal => ({
  ...await importOriginal(),
  randomInt: vi.fn(() => 654321),
}))

import { randomInt } from 'node:crypto'
import User from '../src/models/User.js'
import PendingUser from '../src/models/PendingUser.js'
import sendEmail from '../src/utils/sendEmail.js'
import { register, verifyEmail, resendVerification, login, forgotPassword, resetPassword, checkEmail } from '../src/controllers/auth.controller.js'
import { syncPendingUserExpiryIndexes } from '../src/utils/pendingUserIndexes.js'

const app = express()
app.use(express.json())
app.post('/register', register)
app.post('/verify', verifyEmail)
app.post('/resend', resendVerification)
app.post('/login', login)
app.post('/forgot', forgotPassword)
app.post('/reset', resetPassword)
app.post('/check', checkEmail)
app.use((err, req, res, next) => {
  void next
  res.status(err.statusCode || 500).json({ message: err.message })
})

let mongo
const registration = { name: 'OTP User', email: 'otp@example.test', password: 'SafePassword123!', role: 'student' }

beforeAll(async () => {
  mongo = await MongoMemoryServer.create()
  await mongoose.connect(mongo.getUri())
  await Promise.all([User.init(), PendingUser.init()])
}, 60000)

afterAll(async () => {
  await mongoose.disconnect()
  await mongo?.stop()
})

beforeEach(async () => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
  await Promise.all([User.deleteMany({}), PendingUser.deleteMany({})])
})

describe('Pending registration password and OTP security', () => {
  it.each([
    { name: '' }, { name: '   ' }, { name: 'a'.repeat(101) }, { name: null }, { name: [] },
    { email: 'invalid' }, { email: 'name@domain' }, { email: '@example.test' },
    { email: 'user name@example.test' }, { email: 'name@@example.test' },
    { email: 'name@example.' }, { email: 'name@.test' },
    { password: '' }, { password: '12345' }, { password: null }, { password: { $ne: '' } },
  ])('AUTH-11 rejects invalid fields before database access or sending OTP: %j', async invalid => {
    const findUser = vi.spyOn(User, 'findOne')
    const deletePending = vi.spyOn(PendingUser, 'findOneAndDelete')
    const createPending = vi.spyOn(PendingUser, 'create')
    await request(app).post('/register').send({ ...registration, ...invalid }).expect(400)
    expect(findUser).not.toHaveBeenCalled()
    expect(deletePending).not.toHaveBeenCalled()
    expect(createPending).not.toHaveBeenCalled()
    expect(randomInt).not.toHaveBeenCalled()
    expect(sendEmail).not.toHaveBeenCalled()
  })

  it.each(['X', 'a'.repeat(100), '  Nguyễn Văn An  '])('AUTH-11 accepts valid names and a six-character password through activation: %s', async name => {
    const password = ' abcd '
    await request(app).post('/register').send({ ...registration, name, email: ' OTP@Example.TEST ', password }).expect(201)
    const pending = await PendingUser.findOne({ email: registration.email })
    expect(pending.name).toBe(name.trim())
    expect(await bcrypt.compare(password, pending.password)).toBe(true)
    await request(app).post('/verify').send({ email: registration.email, code: pending.verificationCode }).expect(200)
    await request(app).post('/login').send({ email: registration.email, password }).expect(200)
  })

  it('AUTH-11 invalid input cannot delete even an expired registration', async () => {
    const pending = await PendingUser.create({ ...registration, verificationCode: '123456', verificationCodeExpire: new Date(Date.now() - 1000) })
    await request(app).post('/register').send({ ...registration, password: 'short' }).expect(400)
    expect(await PendingUser.findById(pending._id)).not.toBeNull()
    expect(sendEmail).not.toHaveBeenCalled()
  })

  it('AUTH-08 keeps an unexpired registration intact when another request changes its password or role', async () => {
    await request(app).post('/register').send(registration).expect(201)
    const original = await PendingUser.findOne({ email: registration.email }).lean()
    const response = await request(app).post('/register').send({ ...registration,
      email: ' OTP@EXAMPLE.TEST ', name: 'Replacement', password: 'AttackerPassword!', role: 'teacher', institution: 'Other school' }).expect(409)
    expect(response.body.message).toContain('đang chờ xác thực')
    expect(await PendingUser.findOne({ email: registration.email }).lean()).toEqual(original)
    expect(sendEmail).toHaveBeenCalledTimes(1)
    await request(app).post('/verify').send({ email: registration.email, code: original.verificationCode }).expect(200)
    await request(app).post('/login').send({ email: registration.email, password: registration.password }).expect(200)
    await request(app).post('/login').send({ email: registration.email, password: 'AttackerPassword!' }).expect(401)
  })

  it('AUTH-08 allows replacing an expired registration before MongoDB TTL cleanup', async () => {
    const expired = await PendingUser.create({ ...registration, verificationCode: '111111', verificationCodeExpire: new Date(Date.now() - 1000) })
    const newPassword = 'ReplacementPassword!'
    await request(app).post('/register').send({ ...registration, password: newPassword }).expect(201)
    const current = await PendingUser.findOne({ email: registration.email })
    expect(String(current._id)).not.toBe(String(expired._id))
    expect(await PendingUser.countDocuments({ email: registration.email })).toBe(1)
    expect(await bcrypt.compare(newPassword, current.password)).toBe(true)
    await request(app).post('/verify').send({ email: registration.email, code: '111111' }).expect(400)
  })

  it('AUTH-08 admits exactly one concurrent registration and preserves the winner’s password', async () => {
    const responses = await Promise.all(Array.from({ length: 6 }, (_, i) => request(app).post('/register')
      .send({ ...registration, password: `ConcurrentPassword${i}!` })))
    expect(responses.filter(response => response.status === 201)).toHaveLength(1)
    expect(responses.filter(response => response.status === 409)).toHaveLength(5)
    const winner = responses.findIndex(response => response.status === 201)
    const pending = await PendingUser.findOne({ email: registration.email })
    expect(await PendingUser.countDocuments({ email: registration.email })).toBe(1)
    expect(await bcrypt.compare(`ConcurrentPassword${winner}!`, pending.password)).toBe(true)
    expect(sendEmail).toHaveBeenCalledTimes(1)
  })

  it('AUTH-08 respects the extended expiry after resending an OTP', async () => {
    await request(app).post('/register').send(registration).expect(201)
    await request(app).post('/resend').send({ email: registration.email }).expect(200)
    const extended = await PendingUser.findOne({ email: registration.email }).lean()
    await request(app).post('/register').send({ ...registration, password: 'DifferentPassword!' }).expect(409)
    expect(await PendingUser.findOne({ email: registration.email }).lean()).toEqual(extended)
  })

  it('normalizes email across registration, resend, verify, login, lookup and password reset', async () => {
    const email = '  OTP@Example.TEST  '
    const findUser = vi.spyOn(User, 'findOne')
    const findPending = vi.spyOn(PendingUser, 'findOne')
    const response = await request(app).post('/register').send({ ...registration, email }).expect(201)
    expect(response.body.email).toBe(registration.email)
    expect(findUser).toHaveBeenLastCalledWith({ email: registration.email })
    await request(app).post('/resend').send({ email }).expect(200)
    expect(findPending).toHaveBeenLastCalledWith({ email: registration.email })
    await request(app).post('/verify').send({ email, code: '654321' }).expect(200)
    expect(findPending).toHaveBeenLastCalledWith({ email: registration.email, verificationCode: '654321' })
    await request(app).post('/login').send({ email, password: registration.password }).expect(200)
    expect(findUser).toHaveBeenLastCalledWith({ email: registration.email })
    const checked = await request(app).post('/check').send({ email }).expect(200)
    expect(checked.body.success).toBe(true)
    expect(checked.body.exists).toBeUndefined()
    await request(app).post('/register').send({ ...registration, email }).expect(400)
    await request(app).post('/forgot').send({ email }).expect(200)
    expect(findUser).toHaveBeenLastCalledWith({ email: registration.email })
    const newPassword = ' NewPassword123! '
    await request(app).post('/reset').send({ email, code: '654321', newPassword }).expect(200)
    expect(findUser).toHaveBeenLastCalledWith(expect.objectContaining({ email: registration.email, resetPasswordCode: '654321' }))
    await request(app).post('/login').send({ email, password: newPassword }).expect(200)
    await request(app).post('/login').send({ email, password: newPassword.trim() }).expect(401)
  })

  it.each(['/register', '/resend', '/verify', '/login', '/forgot', '/reset', '/check'])('%s rejects blank or non-string email before querying', async endpoint => {
    const findUser = vi.spyOn(User, 'findOne')
    const findPending = vi.spyOn(PendingUser, 'findOne')
    for (const email of ['   ', { $ne: null }, null, 123]) {
      await request(app).post(endpoint).send({ ...registration, email, code: '654321', newPassword: 'NewPassword123!' }).expect(400)
    }
    expect(findUser).not.toHaveBeenCalled()
    expect(findPending).not.toHaveBeenCalled()
  })

  it('stores a bcrypt hash, transfers it once, and allows login after activation', async () => {
    await request(app).post('/register').send(registration).expect(201)
    const pending = await PendingUser.findOne({ email: registration.email })
    expect(pending.password).not.toBe(registration.password)
    expect(pending.passwordHashed).toBe(true)
    expect(bcrypt.getRounds(pending.password)).toBe(10)
    expect(await bcrypt.compare(registration.password, pending.password)).toBe(true)
    expect(randomInt).toHaveBeenCalledWith(100000, 1000000)

    await request(app).post('/verify').send({ email: registration.email, code: pending.verificationCode }).expect(200)
    const user = await User.findOne({ email: registration.email }).select('+password')
    expect(user.password).toBe(pending.password)
    expect(user.passwordVersion).toBe(1)
    expect(await PendingUser.countDocuments()).toBe(0)
    await request(app).post('/login').send({ email: registration.email, password: registration.password }).expect(200)

    user.password = 'ChangedPassword123!'
    await user.save()
    expect(user.passwordVersion).toBe(2)
    expect(await user.matchPassword('ChangedPassword123!')).toBe(true)
    expect(await user.matchPassword(registration.password)).toBe(false)
  })

  it('still activates a legacy plaintext pending registration', async () => {
    await PendingUser.collection.insertOne({
      ...registration, verificationCode: '123456', verificationCodeExpire: new Date(Date.now() + 60000),
    })
    await request(app).post('/verify').send({ email: registration.email, code: '123456' }).expect(200)
    const user = await User.findOne({ email: registration.email }).select('+password')
    expect(user.password).not.toBe(registration.password)
    expect(await user.matchPassword(registration.password)).toBe(true)
  })

  it('keeps a hashed-password teacher pending approval without issuing a session', async () => {
    await request(app).post('/register').send({ ...registration, role: 'teacher' }).expect(201)
    const response = await request(app).post('/verify')
      .send({ email: registration.email, code: '654321' }).expect(202)
    expect(response.headers['set-cookie']).toBeUndefined()
    expect(response.body.pendingApproval).toBe(true)
    const user = await User.findOne({ email: registration.email }).select('+password')
    expect(user.accountStatus).toBe('pending_approval')
    expect(await user.matchPassword(registration.password)).toBe(true)
  })

  it('does not treat a hash-shaped user password as an already-hashed value', async () => {
    const hashShapedPassword = await bcrypt.hash('another-secret', 10)
    const user = await User.create({ ...registration, password: hashShapedPassword })
    expect(user.password).not.toBe(hashShapedPassword)
    expect(await user.matchPassword(hashShapedPassword)).toBe(true)
  })

  it('rejects expired OTPs without creating a user', async () => {
    await PendingUser.create({ ...registration, verificationCode: '123456', verificationCodeExpire: new Date(Date.now() - 1000) })
    await request(app).post('/verify').send({ email: registration.email, code: '123456' }).expect(400)
    expect(await User.countDocuments()).toBe(0)
  })

  it('resends an OTP without rehashing the password and extends the expiry', async () => {
    const pending = await PendingUser.create({
      ...registration, createdAt: new Date(Date.now() - 14 * 60000),
      verificationCode: '123456', verificationCodeExpire: new Date(Date.now() + 60000),
    })
    const before = Date.now()
    await request(app).post('/resend').send({ email: registration.email }).expect(200)
    const updated = await PendingUser.findById(pending._id)
    expect(updated.password).toBe(pending.password)
    expect(updated.verificationCode).toBe('654321')
    expect(updated.verificationCodeExpire.getTime()).toBeGreaterThanOrEqual(before + 15 * 60000)
    expect(randomInt).toHaveBeenCalledWith(100000, 1000000)
  })

  it('uses cryptographic randomInt for password reset OTPs too', async () => {
    await User.create(registration)
    await request(app).post('/forgot').send({ email: registration.email }).expect(200)
    const user = await User.findOne({ email: registration.email }).select('+resetPasswordCode')
    expect(user.resetPasswordCode).toBe('654321')
    expect(randomInt).toHaveBeenCalledWith(100000, 1000000)
  })

  it('migrates the legacy TTL and preserves unrelated indexes, repeatedly', async () => {
    await PendingUser.collection.createIndex({ createdAt: 1 }, { expireAfterSeconds: 900 })
    await PendingUser.collection.createIndex({ email: 1 })
    await syncPendingUserExpiryIndexes(PendingUser.collection)
    await syncPendingUserExpiryIndexes(PendingUser.collection)
    const indexes = await PendingUser.collection.listIndexes().toArray()
    expect(indexes.some(index => index.key.createdAt && index.expireAfterSeconds !== undefined)).toBe(false)
    expect(indexes.find(index => index.key.verificationCodeExpire)?.expireAfterSeconds).toBe(0)
    expect(indexes.some(index => index.key.email === 1)).toBe(true)
    expect(indexes.find(index => index.name === 'pending_email_unique')?.unique).toBe(true)
    // A record older than the former 15-minute TTL can still verify after resend.
    await PendingUser.create({ ...registration, createdAt: new Date(Date.now() - 20 * 60000),
      verificationCode: '123456', verificationCodeExpire: new Date(Date.now() + 60000) })
    await request(app).post('/resend').send({ email: registration.email }).expect(200)
    await request(app).post('/verify').send({ email: registration.email, code: '654321' }).expect(200)
  })
})

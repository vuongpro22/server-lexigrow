import { beforeAll, afterAll, beforeEach, expect, it } from 'vitest'
import express from 'express'
import request from 'supertest'
import mongoose from 'mongoose'
import jwt from 'jsonwebtoken'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { io as connect } from 'socket.io-client'
import User from '../src/models/User.js'
import { changePassword } from '../src/controllers/profile.controller.js'
import { login, resetPassword } from '../src/controllers/auth.controller.js'
import { protect, optionalAuth } from '../src/middleware/auth.middleware.js'
import { initSocket } from '../src/services/socket.service.js'
import { parseCookies } from '../src/utils/cookie.js'

let mongo, user, server, io
const clients = []
const app = express()
app.use(express.json())
app.use((req, res, next) => { req.cookies = parseCookies(req.headers.cookie || ''); next() })
app.post('/login', login)
app.post('/reset', resetPassword)
app.put('/password', protect, changePassword)
app.get('/me', protect, (req, res) => res.json({ id: req.user.id }))
app.get('/optional', optionalAuth, (req, res) => res.json({ authenticated: Boolean(req.user) }))
app.use((error, req, res, next) => { void next; res.status(error.statusCode || 500).json({ message: error.message }) })
const password = 'Password123!'
const newPassword = 'NewPassword123!'
const cookieOf = response => response.headers['set-cookie'][0].split(';')[0]
const signIn = async () => cookieOf(await request(app).post('/login').send({ email: user.email, password }).expect(200))

beforeAll(async () => {
  mongo = await MongoMemoryServer.create()
  await mongoose.connect(mongo.getUri())
  server = createServer(app)
  io = initSocket(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
}, 60000)
beforeEach(async () => {
  clients.splice(0).forEach(client => client.disconnect())
  await User.deleteMany({})
  user = await User.create({ name: 'User', email: 'session@example.test', password })
})
afterAll(async () => {
  clients.forEach(client => client.disconnect())
  await new Promise(resolve => io.close(resolve))
  await mongoose.disconnect()
  await mongo?.stop()
})

it('refreshes only the current cookie and rejects all older cookies and bearer tokens', async () => {
  const oldCookie = await signIn()
  const changed = await request(app).put('/password').set('Cookie', oldCookie).send({ currentPassword: password, newPassword }).expect(200)
  const freshCookie = cookieOf(changed)
  expect(freshCookie).not.toBe(oldCookie)
  expect(changed.headers['set-cookie'][0]).toMatch(/HttpOnly/)
  expect(changed.body.token).toBeUndefined()
  await request(app).get('/me').set('Cookie', freshCookie).expect(200)
  await request(app).get('/me').set('Cookie', oldCookie).expect(401)
  await request(app).get('/me').set('Authorization', `Bearer ${oldCookie.slice(6)}`).expect(401)
  const guest = await request(app).get('/optional').set('Cookie', oldCookie).expect(200)
  expect(guest.body.authenticated).toBe(false)
})

it('reset-password revokes existing sessions and issues no authenticated session', async () => {
  const cookie = await signIn()
  await User.updateOne({ _id: user._id }, { $set: { resetPasswordCode: '123456', resetPasswordExpire: new Date(Date.now() + 60000) } })
  const reset = await request(app).post('/reset').send({ email: user.email, code: '123456', newPassword }).expect(200)
  expect(reset.headers['set-cookie']).toBeUndefined()
  await request(app).get('/me').set('Cookie', cookie).expect(401)
  await request(app).post('/login').send({ email: user.email, password: newPassword }).expect(200)
})

it('does not revoke sessions or set a cookie for incorrect passwords or invalid input', async () => {
  const cookie = await signIn()
  const failed = await request(app).put('/password').set('Cookie', cookie).send({ currentPassword: 'wrong', newPassword }).expect(401)
  expect(failed.headers['set-cookie']).toBeUndefined()
  await request(app).put('/password').set('Cookie', cookie).send({ currentPassword: {}, newPassword }).expect(400)
  await request(app).get('/me').set('Cookie', cookie).expect(200)
})

it('rejects a stale second password save instead of reusing the same password version', async () => {
  const first = await User.findById(user._id).select('+password')
  const stale = await User.findById(user._id).select('+password')
  first.password = newPassword
  await first.save()
  stale.password = 'StalePassword123!'
  await expect(stale.save()).rejects.toMatchObject({ statusCode: 409 })
  const stored = await User.findById(user._id).select('+password')
  expect(stored.passwordVersion).toBe(2)
  expect(await stored.matchPassword(newPassword)).toBe(true)
})

it('revokes legacy unversioned tokens when a legacy user changes their password', async () => {
  await User.collection.updateOne({ _id: user._id }, { $unset: { passwordVersion: 1 } })
  const legacy = jwt.sign({ id: user.id }, process.env.JWT_SECRET)
  const changed = await request(app).put('/password').set('Authorization', `Bearer ${legacy}`).send({ currentPassword: password, newPassword }).expect(200)
  await request(app).get('/me').set('Authorization', `Bearer ${legacy}`).expect(401)
  await request(app).get('/me').set('Cookie', cookieOf(changed)).expect(200)
})

it('invalidates pending reset and email-change codes on password change', async () => {
  await User.updateOne({ _id: user._id }, { $set: { resetPasswordCode: '123456', resetPasswordExpire: new Date(Date.now() + 60000),
    emailChange: { email: 'new@example.test', codeHash: 'pending', passwordVersion: 1 } } })
  user.password = newPassword
  await user.save()
  const stored = await User.findById(user._id).select('+emailChange +resetPasswordCode +resetPasswordExpire')
  expect(stored.resetPasswordCode).toBe('')
  expect(stored.resetPasswordExpire).toBeUndefined()
  expect(stored.emailChange).toBeUndefined()
})

it('disconnects an old socket on its next packet and refuses reconnection with the old JWT', async () => {
  const cookie = await signIn()
  const token = cookie.slice(6)
  const url = `http://127.0.0.1:${server.address().port}`
  const client = connect(url, { transports: ['websocket'], auth: { token }, reconnection: false })
  clients.push(client)
  await once(client, 'connect')
  await request(app).put('/password').set('Cookie', cookie).send({ currentPassword: password, newPassword }).expect(200)
  const disconnected = once(client, 'disconnect')
  client.emit('join_chat_room', 'support')
  await disconnected
  const stale = connect(url, { transports: ['websocket'], auth: { token }, reconnection: false })
  clients.push(stale)
  const [error] = await once(stale, 'connect_error')
  expect(error.message).toContain('Session expired')
})

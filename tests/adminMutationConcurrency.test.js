import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import mongoose from 'mongoose'
import express from 'express'
import request from 'supertest'
import { MongoMemoryServer } from 'mongodb-memory-server'

vi.mock('../src/utils/auditLogger.js', () => ({ logAction: vi.fn() }))
vi.mock('../src/services/socket.service.js', () => ({ disconnectUserSockets: vi.fn(), syncParentLinkedRooms: vi.fn() }))

import User from '../src/models/User.js'
import Class from '../src/models/Class.js'
import AdminMutationLock from '../src/models/AdminMutationLock.js'
import Notification from '../src/models/Notification.js'
import { respondParentRequest } from '../src/controllers/notification.controller.js'
import { updateUserRole, updateUserStatus, deleteUser } from '../src/controllers/admin.user.controller.js'

let mongo, otherConnection, admins
const app = express()
app.use(express.json())
// Preserve the authentication snapshots of two already-authorized requests.
app.use((req, res, next) => { req.user = admins[Number(req.headers['x-actor'] || 0)]; next() })
app.patch('/users/:id/role', updateUserRole)
app.patch('/users/:id/status', updateUserStatus)
app.delete('/users/:id', deleteUser)
app.post('/notifications/:id/respond', respondParentRequest)
app.use((error, req, res, next) => { void next; res.status(error.statusCode || 500).json({ message: error.message }) })

beforeAll(async () => {
  mongo = await MongoMemoryServer.create()
  await mongoose.connect(mongo.getUri())
  otherConnection = await mongoose.createConnection(mongo.getUri()).asPromise()
  await AdminMutationLock.init()
}, 60000)

beforeEach(async () => {
  vi.restoreAllMocks()
  await User.deleteMany({})
  await Class.deleteMany({})
  await AdminMutationLock.deleteMany({})
  await Notification.deleteMany({})
  admins = await User.insertMany([0, 1].map(i => ({ name: `Admin ${i}`, email: `${i}@test.example`,
    password: 'unused-test-password', role: 'admin', accountStatus: 'active' })))
})

afterAll(async () => {
  await otherConnection?.close()
  await mongoose.disconnect()
  await mongo?.stop()
})

describe('AD-01 admin membership concurrency on standalone MongoDB', () => {
  it('ADMIN-14 blocks a teacher with active classes, then allows the change after archiving', async () => {
    const teacher = await User.create({ name: 'Teacher', email: 'teacher@test.example', password: 'Password123!', role: 'teacher' })
    const active = await Class.create({ name: 'Active class', teacher: teacher._id, status: 'active' })
    await Class.create({ name: 'Archived class', teacher: teacher._id, status: 'archived' })
    await request(app).patch(`/users/${teacher.id}/role`).send({ role: 'student' }).expect(409)
    expect((await User.findById(teacher._id)).role).toBe('teacher')
    active.status = 'archived'
    await active.save()
    await request(app).patch(`/users/${teacher.id}/role`).send({ role: 'student' }).expect(200)
    expect((await User.findById(teacher._id)).role).toBe('student')
    expect(await Class.countDocuments({ teacher: teacher._id, status: 'archived' })).toBe(2)
  })

  it.each(['archived', 'draft'])('ADMIN-14 permits a teacher with only %s classes to change role', async status => {
    const teacher = await User.create({ name: 'Teacher', email: 'teacher@test.example', password: 'Password123!', role: 'teacher' })
    await Class.create({ name: 'Inactive class', teacher: teacher._id, status })
    // An unrelated teacher's active class must not block this teacher.
    await Class.create({ name: 'Other active class', teacher: admins[1]._id, status: 'active' })
    await request(app).patch(`/users/${teacher.id}/role`).send({ role: 'student' }).expect(200)
    expect((await User.findById(teacher._id)).role).toBe('student')
  })

  it('allows only one of two simultaneous cross-demotions, including across DB connections', async () => {
    const countDocuments = User.countDocuments.bind(User)
    let release, counted
    const paused = new Promise(resolve => { release = resolve })
    const entered = new Promise(resolve => { counted = resolve })
    vi.spyOn(User, 'countDocuments').mockImplementationOnce(async filter => {
      const count = await countDocuments(filter)
      counted()
      await paused
      return count
    })
    const first = request(app).patch(`/users/${admins[1].id}/role`).send({ role: 'student' }).then(res => res)
    await entered
    try {
      // A different connection sees the same lock; this is not a process-local mutex.
      expect(await otherConnection.collection(AdminMutationLock.collection.name).countDocuments()).toBe(1)
      await request(app).patch(`/users/${admins[0].id}/role`).set('x-actor', '1').send({ role: 'student' }).expect(409)
    } finally {
      release()
    }
    expect((await first).status).toBe(200)
    expect(await User.countDocuments({ role: 'admin', accountStatus: 'active' })).toBe(1)
    // A delayed authorized request must also re-read and refuse the last admin.
    const retry = await request(app).patch(`/users/${admins[0].id}/role`).set('x-actor', '1').send({ role: 'student' }).expect(409)
    expect(retry.body.message).toContain('ít nhất một quản trị viên')
    expect(await AdminMutationLock.countDocuments()).toBe(0)
  })

  it('respects a lock acquired by another backend and never deletes that owner’s lock', async () => {
    const collection = otherConnection.collection(AdminMutationLock.collection.name)
    await collection.insertOne({ _id: 'admin-user-mutations', owner: 'other-backend', acquiredAt: new Date(0) })
    await request(app).patch(`/users/${admins[1].id}/role`).send({ role: 'student' }).expect(409)
    expect((await collection.findOne({ _id: 'admin-user-mutations' })).owner).toBe('other-backend')
    expect(await User.countDocuments({ role: 'admin', accountStatus: 'active' })).toBe(2)
  })

  it('releases the lock on validation errors and database failures', async () => {
    await request(app).patch(`/users/${admins[1].id}/role`).send({ role: 'invalid' }).expect(400)
    expect(await AdminMutationLock.countDocuments()).toBe(0)
    vi.spyOn(User, 'findById').mockRejectedValueOnce(new Error('DB read failed'))
    await request(app).patch(`/users/${admins[1].id}/role`).send({ role: 'student' }).expect(500)
    expect(await AdminMutationLock.countDocuments()).toBe(0)
    await request(app).patch(`/users/${admins[1].id}/role`).send({ role: 'student' }).expect(200)
  })

  it('continues blocking admin suspension, deletion and self-demotion', async () => {
    await request(app).patch(`/users/${admins[1].id}/status`).send({ status: 'suspended' }).expect(403)
    await request(app).delete(`/users/${admins[1].id}`).expect(403)
    await request(app).patch(`/users/${admins[0].id}/role`).send({ role: 'student' }).expect(403)
    expect(await User.countDocuments({ role: 'admin', accountStatus: 'active' })).toBe(2)
    expect(await AdminMutationLock.countDocuments()).toBe(0)
  })

  it('cannot reject an admin through a stale parent approval notification', async () => {
    const notice = await Notification.create({ recipient: admins[0]._id, relatedUser: admins[1]._id,
      type: 'parent_notice', title: 'Old parent request', message: 'Old request' })
    await request(app).post(`/notifications/${notice.id}/respond`).send({ action: 'reject' }).expect(409)
    expect(await User.countDocuments({ role: 'admin', accountStatus: 'active' })).toBe(2)
  })

  it('atomically refuses parent rejection when the parent is promoted after being read', async () => {
    const parent = await User.create({ name: 'Parent', email: 'parent@test.example', password: 'Password123!', role: 'parent' })
    const notice = await Notification.create({ recipient: admins[0]._id, relatedUser: parent._id,
      type: 'parent_notice', title: 'Request', message: 'Request' })
    const findById = User.findById.bind(User)
    vi.spyOn(User, 'findById').mockImplementationOnce(async id => {
      const snapshot = await findById(id)
      await User.updateOne({ _id: id }, { $set: { role: 'admin' } })
      return snapshot
    })
    await request(app).post(`/notifications/${notice.id}/respond`).send({ action: 'reject' }).expect(409)
    const updated = await findById(parent._id)
    expect(updated.role).toBe('admin')
    expect(updated.accountStatus).toBe('active')
  })
})

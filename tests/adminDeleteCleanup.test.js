import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import mongoose from 'mongoose'
import { MongoMemoryServer } from 'mongodb-memory-server'
import request from 'supertest'
import jwt from 'jsonwebtoken'

import app from '../src/app.js'
import User from '../src/models/User.js'
import ParentStudentLink from '../src/models/ParentStudentLink.js'
import Notification from '../src/models/Notification.js'
import ChildLinkCode from '../src/models/ChildLinkCode.js'
import Essay from '../src/models/Essay.js'
import AIAnalysis from '../src/models/AIAnalysis.js'
import AuditLog from '../src/models/AuditLog.js'

let mongo
let admin
let parent
let student
let token

const asAdmin = (req) => req.set('Authorization', `Bearer ${token}`)

beforeAll(async () => {
  mongo = await MongoMemoryServer.create()
  await mongoose.connect(mongo.getUri())
  await Promise.all(Object.values(mongoose.models).map((model) => model.init()))
}, 120000)

afterAll(async () => {
  await mongoose.disconnect()
  if (mongo) await mongo.stop()
}, 30000)

beforeEach(async () => {
  await Promise.all(Object.values(mongoose.models).map((model) => model.deleteMany({})))

  admin = await User.create({
    name: 'Admin',
    email: 'admin@example.test',
    password: 'password1',
    role: 'admin',
  })
  parent = await User.create({
    name: 'Parent',
    email: 'parent@example.test',
    password: 'password1',
    role: 'parent',
  })
  student = await User.create({
    name: 'Student',
    email: 'student@example.test',
    password: 'password1',
    role: 'student',
  })

  await ParentStudentLink.create({
    parent: parent._id,
    student: student._id,
    relationship: 'mother',
  })
  await User.updateOne({ _id: parent._id }, { $addToSet: { children: student._id } })
  await User.updateOne({ _id: student._id }, { $addToSet: { parents: parent._id } })

  token = jwt.sign({ id: admin._id }, process.env.JWT_SECRET)
})

describe('admin delete user cleans parent-student links', () => {
  it('soft-deletes all authored essay states, retains content and excludes IDs, lists and statistics', async () => {
    const essays = await Essay.create(['draft', 'submitted', 'reviewed', 'needs_revision'].map(status => ({
      title: status, content: 'Retained original content.', student: student._id, status,
    })))
    const otherStudent = await User.create({ name: 'Other', email: 'other@example.test', password: 'password1' })
    const otherEssay = await Essay.create({ title: 'Still visible', content: 'Other student content', student: otherStudent._id, status: 'reviewed' })
    await AIAnalysis.create([{ essay: essays[2]._id, overallScore: 2 }, { essay: otherEssay._id, overallScore: 8 }])
    const staleEssay = await Essay.findById(essays[0]._id)

    await asAdmin(request(app).delete(`/api/admin/users/${student._id}`)).expect(200)
    const retained = await Essay.collection.find({ student: student._id }).toArray()
    expect(retained).toHaveLength(4)
    for (const essay of retained) {
      expect(essay.content).toBe('Retained original content.')
      expect(essay.deletedAt).toBeInstanceOf(Date)
      expect(String(essay.deletedBy)).toBe(String(admin._id))
    }
    expect(await Essay.find({ student: student._id })).toEqual([])
    expect(await Essay.countDocuments({ student: student._id })).toBe(0)
    expect(await Essay.distinct('_id', { student: student._id })).toEqual([])
    expect(await Essay.aggregate([{ $match: { student: student._id } }, { $count: 'total' }])).toEqual([])
    expect(await Essay.findById(essays[0]._id)).toBeNull()
    expect(await Essay.findByIdAndUpdate(essays[0]._id, { content: 'Must not change' })).toBeNull()
    expect((await Essay.updateOne({ _id: essays[0]._id }, { $set: { status: 'submitted' } })).matchedCount).toBe(0)
    staleEssay.content = 'Stale write must fail'
    await expect(staleEssay.save()).rejects.toMatchObject({ name: 'DocumentNotFoundError' })
    for (const essay of essays) {
      await asAdmin(request(app).get(`/api/essays/${essay._id}`)).expect(404)
      await asAdmin(request(app).get(`/api/essays/${essay._id}/analysis`)).expect(404)
      await asAdmin(request(app).get(`/api/comments/essay/${essay._id}`)).expect(404)
      await asAdmin(request(app).get(`/api/feedback/essay/${essay._id}`)).expect(404)
    }
    const list = await asAdmin(request(app).get('/api/essays')).expect(200)
    expect(list.body.total).toBe(1)
    expect(list.body.data.map(essay => essay._id)).toEqual([String(otherEssay._id)])
    const analytics = await asAdmin(request(app).get('/api/admin/analytics')).expect(200)
    expect(analytics.body.data.metrics.totalEssays).toBe(1)
    expect(analytics.body.data.metrics.avgScore).toBe(8)
    expect(analytics.body.data.charts.scoreDistribution.reduce((sum, bucket) => sum + bucket.count, 0)).toBe(1)
    const log = await AuditLog.findOne({ action: 'ADMIN_DELETE_USER', targetId: String(student._id) })
    expect(log.details.softDeletedEssays).toBe(4)
    expect(await AIAnalysis.countDocuments({ essay: { $in: essays.map(essay => essay._id) } })).toBe(1)
  })

  it('keeps student essays when their parent or teacher is deleted', async () => {
    const essay = await Essay.create({ title: 'Student work', student: student._id })
    await asAdmin(request(app).delete(`/api/admin/users/${parent._id}`)).expect(200)
    const teacher = await User.create({ name: 'Teacher', email: 'teacher@example.test', password: 'password1', role: 'teacher' })
    await asAdmin(request(app).delete(`/api/admin/users/${teacher._id}`)).expect(200)
    expect((await Essay.findById(essay._id)).deletedAt).toBeNull()
  })

  it('keeps legacy essays without deletion fields visible until deleting their author', async () => {
    const { insertedId } = await Essay.collection.insertOne({ title: 'Legacy', content: 'Legacy content', student: student._id, status: 'submitted' })
    expect(await Essay.findById(insertedId)).not.toBeNull()
    expect(await Essay.countDocuments({ student: student._id })).toBe(1)
    await asAdmin(request(app).delete(`/api/admin/users/${student._id}`)).expect(200)
    expect(await Essay.findById(insertedId)).toBeNull()
    expect((await Essay.collection.findOne({ _id: insertedId })).deletedAt).toBeInstanceOf(Date)
  })

  it('preserves metadata of essays already soft-deleted before the user deletion', async () => {
    const deletedAt = new Date('2026-01-01T00:00:00Z')
    const essay = await Essay.create({ title: 'Previously deleted', student: student._id, deletedAt, deletedBy: parent._id })
    await asAdmin(request(app).delete(`/api/admin/users/${student._id}`)).expect(200)
    const stored = await Essay.collection.findOne({ _id: essay._id })
    expect(stored.deletedAt).toEqual(deletedAt)
    expect(String(stored.deletedBy)).toBe(String(parent._id))
  })

  it('removes a deleted parent from the student side and revokes the link', async () => {
    await Notification.create({
      recipient: student._id,
      relatedUser: parent._id,
      title: 'Parent verification request',
      message: 'Please confirm',
      type: 'parent_notice',
    })

    await asAdmin(request(app).delete(`/api/admin/users/${parent._id}`)).expect(200)

    const deletedParent = await User.findById(parent._id)
    const refreshedStudent = await User.findById(student._id)
    const link = await ParentStudentLink.findOne({ parent: parent._id, student: student._id })

    expect(deletedParent.accountStatus).toBe('deleted')
    expect(deletedParent.children).toHaveLength(0)
    expect(refreshedStudent.parents.map(String)).not.toContain(String(parent._id))
    expect(link.status).toBe('revoked')
    expect(await Notification.countDocuments({ relatedUser: parent._id })).toBe(0)
  })

  it('removes a deleted student from the parent side and clear pending link codes', async () => {
    await ChildLinkCode.create({
      student: student._id,
      codeHash: 'hash-for-deleted-student',
      expiresAt: new Date(Date.now() + 60_000),
    })
    await Notification.create({
      recipient: parent._id,
      relatedUser: student._id,
      title: 'Learning alert',
      message: 'Student needs attention',
      type: 'academic_alert',
    })

    await asAdmin(request(app).delete(`/api/admin/users/${student._id}`)).expect(200)

    const deletedStudent = await User.findById(student._id)
    const refreshedParent = await User.findById(parent._id)
    const link = await ParentStudentLink.findOne({ parent: parent._id, student: student._id })

    expect(deletedStudent.accountStatus).toBe('deleted')
    expect(deletedStudent.parents).toHaveLength(0)
    expect(refreshedParent.children.map(String)).not.toContain(String(student._id))
    expect(link.status).toBe('revoked')
    expect(await ChildLinkCode.countDocuments({ student: student._id })).toBe(0)
    expect(await Notification.countDocuments({ relatedUser: student._id })).toBe(0)
  })
})

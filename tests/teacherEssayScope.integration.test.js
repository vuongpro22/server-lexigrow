import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import mongoose from 'mongoose'
import { MongoMemoryServer } from 'mongodb-memory-server'
import User from '../src/models/User.js'
import Class from '../src/models/Class.js'
import Assignment from '../src/models/Assignment.js'
import Essay from '../src/models/Essay.js'
import ManualFeedback from '../src/models/ManualFeedback.js'
import { getStudentEssays, getStudentAnalytics } from '../src/controllers/teacher.controller.js'
import { getPendingEssays, createFeedback, getFeedbackByEssay } from '../src/controllers/feedback.controller.js'

let mongo
let teacherOld
let teacherNew
let student
let classOld
let classNew
let classExtra
let assignmentOld
let assignmentNew
let essayOldId
let essayNewId

const essayContent = Array(60).fill('word').join(' ')

function request(userId, studentId = student._id, query = {}) {
  return {
    user: { _id: userId, role: 'teacher', name: 'Teacher' },
    params: { id: String(studentId) },
    query,
  }
}

function response() {
  const res = {
    statusCode: null,
    body: null,
    status: vi.fn(code => {
      res.statusCode = code
      return res
    }),
    json: vi.fn(body => {
      res.body = body
      return res
    }),
  }
  return res
}

async function invoke(handler, req) {
  const res = response()
  const next = vi.fn()
  await handler(req, res, next)
  return { res, next }
}

beforeAll(async () => {
  mongo = await MongoMemoryServer.create()
  await mongoose.connect(mongo.getUri())
  await Promise.all(Object.values(mongoose.models).map(model => model.init()))
}, 120000)

afterAll(async () => {
  await mongoose.disconnect()
  if (mongo) await mongo.stop()
}, 30000)

beforeEach(async () => {
  await Promise.all(Object.values(mongoose.models).map(model => model.deleteMany({})))
  ;[teacherOld, teacherNew, student] = await User.create([
    { name: 'Old Teacher', email: 'old@example.test', password: 'password1', role: 'teacher', accountStatus: 'active' },
    { name: 'New Teacher', email: 'new@example.test', password: 'password1', role: 'teacher', accountStatus: 'active' },
    { name: 'Student', email: 'student@example.test', password: 'password1', role: 'student', accountStatus: 'active' },
  ])

  ;[classOld, classNew, classExtra] = await Class.create([
    { name: 'Old archived class', teacher: teacherOld._id, students: [student._id], status: 'archived' },
    { name: 'New class', teacher: teacherNew._id, students: [student._id], status: 'active' },
    { name: 'Extra class', teacher: teacherOld._id, students: [student._id], status: 'active' },
  ])

  ;[assignmentOld, assignmentNew] = await Assignment.create([
    { title: 'Old assignment', dueDate: new Date('2026-01-01'), classId: classOld._id, teacher: teacherOld._id },
    { title: 'New assignment', dueDate: new Date('2026-12-01'), classId: classNew._id, teacher: teacherNew._id },
  ])

  const createdEssays = await Essay.create([
    {
      title: 'Old essay',
      content: essayContent,
      student: student._id,
      class: classOld._id,
      assignment: assignmentOld._id,
      status: 'submitted',
      submittedAt: new Date('2026-01-02'),
    },
    {
      title: 'New essay',
      content: essayContent,
      student: student._id,
      class: classNew._id,
      assignment: assignmentNew._id,
      status: 'submitted',
      submittedAt: new Date('2026-12-02'),
    },
    {
      title: 'Extra essay',
      content: essayContent,
      student: student._id,
      class: classExtra._id,
      status: 'submitted',
      submittedAt: new Date('2026-11-02'),
    },
  ])
  essayOldId = createdEssays[0]._id
  essayNewId = createdEssays[1]._id
})

describe('TEACH-03 integration with real MongoDB', () => {
  it('shows the old teacher only essays from their archived class', async () => {
    const { res, next } = await invoke(getStudentEssays, request(teacherOld._id))

    expect(next).not.toHaveBeenCalled()
    expect(res.statusCode).toBe(200)
    expect(res.body.total).toBe(2)
    expect(res.body.data.map(essay => essay.title).sort()).toEqual(['Extra essay', 'Old essay'])
    expect(res.body.data.map(essay => essay.title)).not.toContain('New essay')
  })

  it('does not leak the new teacher class through student analytics', async () => {
    const { res, next } = await invoke(getStudentAnalytics, request(teacherOld._id))

    expect(next).not.toHaveBeenCalled()
    expect(res.statusCode).toBe(200)
    expect(res.body.data.metrics.totalEssays).toBe(2)
    expect(res.body.data.essayHistory.map(essay => essay.title).sort()).toEqual(['Extra essay', 'Old essay'])
    expect(res.body.data.essayHistory.map(essay => essay.title)).not.toContain('New essay')
  })

  it('lets the new teacher see only the new class essay', async () => {
    const { res } = await invoke(getStudentEssays, request(teacherNew._id))

    expect(res.statusCode).toBe(200)
    expect(res.body.data.map(essay => essay.title)).toEqual(['New essay'])
  })

  it('denies access after the student leaves every class of the old teacher', async () => {
    await Class.updateMany(
      { teacher: teacherOld._id },
      { $pull: { students: student._id } },
    )

    const { next } = await invoke(getStudentEssays, request(teacherOld._id))

    expect(next).toHaveBeenCalledOnce()
    expect(next.mock.calls[0][0].statusCode).toBe(403)
  })

  it('does not include classless or draft essays', async () => {
    await Essay.create([
      { title: 'Classless essay', content: essayContent, student: student._id, status: 'submitted' },
      { title: 'Draft essay', content: essayContent, student: student._id, class: classOld._id, status: 'draft' },
    ])

    const { res } = await invoke(getStudentEssays, request(teacherOld._id))

    expect(res.body.data.map(essay => essay.title).sort()).toEqual(['Extra essay', 'Old essay'])
    expect(res.body.total).toBe(2)
  })

  it('paginates within the scoped essay list', async () => {
    const { res } = await invoke(getStudentEssays, request(teacherOld._id, student._id, { page: '1', limit: '1' }))

    expect(res.statusCode).toBe(200)
    expect(res.body.count).toBe(1)
    expect(res.body.total).toBe(2)
    expect(res.body.data).toHaveLength(1)
  })

  it('keeps the new class essay out of the old teacher feedback queue', async () => {
    const { res, next } = await invoke(getPendingEssays, request(teacherOld._id))

    expect(next).not.toHaveBeenCalled()
    expect(res.statusCode).toBe(200)
    expect(res.body.data.map(essay => essay.title).sort()).toEqual(['Extra essay', 'Old essay'])
    expect(res.body.data.map(essay => essay.title)).not.toContain('New essay')
  })

  it('blocks grading the new class essay through the feedback endpoint', async () => {
    const { next } = await invoke(createFeedback, {
      ...request(teacherOld._id),
      params: { essayId: String(essayNewId) },
      body: { scores: { grammar: 8 }, feedbackText: 'Should not be allowed' },
    })

    expect(next).toHaveBeenCalledOnce()
    expect(next.mock.calls[0][0].statusCode).toBe(403)
    expect(await ManualFeedback.countDocuments({ essay: essayNewId })).toBe(0)
  })

  it('blocks feedback reads and writes on another teacher essay', async () => {
    const read = await invoke(getFeedbackByEssay, {
      ...request(teacherOld._id),
      params: { essayId: String(essayNewId) },
    })
    expect(read.next).toHaveBeenCalledOnce()
    expect(read.next.mock.calls[0][0].statusCode).toBe(404)

    const archivedWrite = await invoke(createFeedback, {
      ...request(teacherOld._id),
      params: { essayId: String(essayOldId) },
      body: { scores: { grammar: 8 }, feedbackText: 'Archived class should be read only' },
    })
    expect(archivedWrite.next).toHaveBeenCalledOnce()
    expect(archivedWrite.next.mock.calls[0][0].statusCode).toBe(409)
    expect(archivedWrite.next.mock.calls[0][0].code).toBe('CLASS_NOT_ACTIVE')
  })

  it('still allows grading an essay in the old teacher active class', async () => {
    const extraEssay = await Essay.findOne({ title: 'Extra essay' })
    const { res, next } = await invoke(createFeedback, {
      ...request(teacherOld._id),
      params: { essayId: String(extraEssay._id) },
      body: { scores: { grammar: 8 }, feedbackText: 'Allowed feedback' },
    })

    expect(next).not.toHaveBeenCalled()
    expect(res.statusCode).toBe(201)
    expect(await ManualFeedback.countDocuments({ essay: extraEssay._id, teacher: teacherOld._id })).toBe(1)
  })
})

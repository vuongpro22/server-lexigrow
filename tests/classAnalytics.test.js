import { vi, describe, it, expect } from 'vitest'

// Mock db connection
vi.mock('../src/config/db.js', () => ({
  default: vi.fn().mockImplementation(() => Promise.resolve())
}))

// Mock models
vi.mock('../src/models/Class.js', () => ({
  default: {
    findById: vi.fn(),
    findOne: vi.fn(),
    find: vi.fn(),
    updateOne: vi.fn()
  }
}))
vi.mock('../src/models/Essay.js', () => ({
  default: {
    find: vi.fn(),
  }
}))
vi.mock('../src/models/AIAnalysis.js', () => ({
  default: {
    find: vi.fn(),
  }
}))

// Mock protect middleware to inject a mock req.user dynamically based on requested URL
vi.mock('../src/middleware/auth.middleware.js', () => ({
  optionalAuth: (req, res, next) => next(),
  protect: (req, res, next) => {
    if (req.path.includes('/analytics') || req.path.includes('/requests') || req.path.includes('/insights')) {
      req.user = { _id: 'aaaaaaaaaaaaaaaaaaaaaaaa', role: 'teacher', name: 'Mock Teacher' }
    } else {
      req.user = { _id: 'bbbbbbbbbbbbbbbbbbbbbbbb', role: 'student', name: 'Mock Student' }
    }
    next()
  },
  authorize: () => (req, res, next) => {
    next()
  }
}))

vi.mock('../src/services/classQuota.service.js', () => ({
  assertClassCapacity: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../src/services/studentQuota.service.js', () => ({
  assertStudentCapacity: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../src/services/teacherQuotaLock.service.js', () => ({
  withTeacherQuotaLock: (_teacherIds, operation) => operation(),
}))

// Mock notifications and logger services
vi.mock('../src/services/notification.service.js', () => ({
  createNotification: vi.fn().mockResolvedValue({})
}))
vi.mock('../src/utils/auditLogger.js', () => ({
  logAction: vi.fn().mockResolvedValue({})
}))

import request from 'supertest'
import app from '../src/index.js'
import Class from '../src/models/Class.js'
import Essay from '../src/models/Essay.js'
import AIAnalysis from '../src/models/AIAnalysis.js'

describe('Class Analytics & Access API', () => {
  it('should return 200 and valid statistics structure', async () => {
    // 1. Mock Class.findById
    Class.findById.mockResolvedValue({
      _id: 'cccccccccccccccccccccccc',
      teacher: 'aaaaaaaaaaaaaaaaaaaaaaaa',
      students: ['student1', 'student2'],
      name: 'Class A'
    })

    // 2. Mock Essay.find
    Essay.find.mockResolvedValue([
      { _id: 'essay1', student: 'student1' },
      { _id: 'essay2', student: 'student2' }
    ])

    // 3. Mock AIAnalysis.find
    AIAnalysis.find.mockResolvedValue([
      {
        essay: 'essay1',
        scores: { vocabularyDiversity: 0.5, grammarAccuracy: 7.0 },
        createdAt: new Date()
      },
      {
        essay: 'essay2',
        scores: { vocabularyDiversity: 0.6, grammarAccuracy: 8.0 },
        createdAt: new Date()
      }
    ])

    const res = await request(app)
      .get('/api/classes/cccccccccccccccccccccccc/analytics')
      .expect(200)

    expect(res.body.success).toBe(true)
    expect(res.body.data.summary.overallAvgTTR).toBe(0.55)
    expect(res.body.data.summary.overallAvgGrammar).toBe(7.5)
    expect(res.body.data.summary.totalEssaysAnalyzed).toBe(2)
    expect(res.body.data.trend).toHaveLength(6)
  })

  it('should return 403 if class teacher does not match requester', async () => {
    Class.findById.mockResolvedValue({
      _id: 'cccccccccccccccccccccccc',
      teacher: 'another_teacher_id',
      students: [],
      name: 'Class B'
    })

    const res = await request(app)
      .get('/api/classes/cccccccccccccccccccccccc/analytics')
      .expect(403)

    expect(res.body.success).toBe(false)
  })

  it('should return 200 and valid insights data structure', async () => {
    Class.findById.mockResolvedValue({
      _id: 'cccccccccccccccccccccccc',
      teacher: 'aaaaaaaaaaaaaaaaaaaaaaaa',
      students: ['student1', 'student2'],
      name: 'Class A'
    })

    Essay.find.mockResolvedValue([
      { _id: 'essay1', student: 'student1' },
      { _id: 'essay2', student: 'student2' }
    ])

    AIAnalysis.find.mockResolvedValue([
      {
        essay: 'essay1',
        nlpStats: {
          repeatedWords: [{ word: 'however', count: 5 }, { word: 'very', count: 3 }]
        },
        suggestions: [
          { type: 'improvement', text: 'You made a tense grammar error here.' }
        ]
      },
      {
        essay: 'essay2',
        nlpStats: {
          repeatedWords: [{ word: 'however', count: 2 }]
        },
        suggestions: [
          { type: 'improvement', text: 'Check your article preposition usage in this sentence.' }
        ]
      }
    ])

    const res = await request(app)
      .get('/api/classes/cccccccccccccccccccccccc/insights')
      .expect(200)

    expect(res.body.success).toBe(true)
    expect(res.body.data.repeatedWords).toHaveLength(2)
    expect(res.body.data.repeatedWords[0].word).toBe('however')
    expect(res.body.data.repeatedWords[0].count).toBe(7)
    expect(res.body.data.repeatedWords[0].studentCount).toBe(2)
    expect(res.body.data.grammarErrors).toHaveLength(2)
  })

  it('should allow student to request to join a class by class code', async () => {
    Class.findOne.mockResolvedValue({
      _id: 'cccccccccccccccccccccccc',
      name: 'IELTS Basic',
      teacher: 'aaaaaaaaaaaaaaaaaaaaaaaa',
      students: [],
      pendingStudents: [],
    })

    const res = await request(app)
      .post('/api/classes/join')
      .send({ code: 'IELTS6' })
      .expect(200)

    expect(res.body.success).toBe(true)
    expect(res.body.message).toContain('Đã gửi yêu cầu vào lớp')
    expect(Class.updateOne).toHaveBeenCalledWith(
      { _id: 'cccccccccccccccccccccccc' },
      { $addToSet: { pendingStudents: 'bbbbbbbbbbbbbbbbbbbbbbbb' } },
    )
  })

  it('rejects a join request up front when the teacher has no free student slot', async () => {
    const { assertStudentCapacity } = await import('../src/services/studentQuota.service.js')
    const { default: ErrorResponse } = await import('../src/utils/ErrorResponse.js')
    Class.updateOne.mockClear()
    assertStudentCapacity.mockRejectedValueOnce(new ErrorResponse('Gói hiện tại cho phép tối đa 0 học sinh', 403))
    Class.findOne.mockResolvedValue({
      _id: 'cccccccccccccccccccccccc',
      name: 'Free Class',
      teacher: 'aaaaaaaaaaaaaaaaaaaaaaaa',
      status: 'active',
      students: [],
      pendingStudents: [],
    })

    const res = await request(app)
      .post('/api/classes/join')
      .send({ code: 'FREE01' })
      .expect(403)

    expect(res.body.code).toBe('CLASS_CAPACITY_REACHED')
    expect(Class.updateOne).not.toHaveBeenCalled()
  })

  it('rejects joining an archived class', async () => {
    Class.updateOne.mockClear()
    Class.findOne.mockResolvedValue({
      _id: 'cccccccccccccccccccccccc', name: 'Old', teacher: 'aaaaaaaaaaaaaaaaaaaaaaaa',
      status: 'archived', students: [], pendingStudents: [],
    })
    await request(app).post('/api/classes/join').send({ code: 'OLD001' }).expect(400)
    expect(Class.updateOne).not.toHaveBeenCalled()
  })

  it('should allow teacher to approve a pending student request', async () => {
    const mockSave = vi.fn().mockResolvedValue({})
    Class.findById.mockResolvedValue({
      _id: 'cccccccccccccccccccccccc',
      name: 'IELTS Basic',
      teacher: 'aaaaaaaaaaaaaaaaaaaaaaaa',
      students: [],
      pendingStudents: ['bbbbbbbbbbbbbbbbbbbbbbbb'],
      save: mockSave
    })

    const res = await request(app)
      .post('/api/classes/cccccccccccccccccccccccc/requests/bbbbbbbbbbbbbbbbbbbbbbbb/handle')
      .send({ action: 'approve' })
      .expect(200)

    expect(res.body.success).toBe(true)
    expect(res.body.message).toContain('Đã duyệt')
    expect(mockSave).toHaveBeenCalled()
  })
})

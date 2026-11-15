import { vi, describe, it, expect, beforeEach } from 'vitest'
import { createMockContext } from './testHelper.js'

vi.mock('../../src/config/db.js', () => ({
  default: vi.fn().mockImplementation(() => Promise.resolve())
}))

vi.mock('../../src/models/Essay.js', () => ({
  default: {
    findById: vi.fn(),
  }
}))

vi.mock('../../src/models/Assignment.js', () => ({
  default: {
    findById: vi.fn(),
  }
}))

vi.mock('../../src/models/Class.js', () => ({
  default: {
    findById: vi.fn(),
  }
}))

vi.mock('../../src/services/ai.service.js', () => ({
  processEssayAnalysis: vi.fn().mockResolvedValue({}),
}))

import Essay from '../../src/models/Essay.js'
import Assignment from '../../src/models/Assignment.js'
import Class from '../../src/models/Class.js'
import { updateEssay } from '../../src/controllers/essay.controller.js'

describe('F51: Save Essay Draft (updateEssay)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('UTCID01 (N): should save draft essay owned by the student', async () => {
    const saveMock = vi.fn().mockResolvedValue(true)
    const existingEssay = {
      _id: 'essay_51_1',
      student: 'student_1',
      title: 'Old Title',
      content: 'Draft content in progress',
      status: 'draft',
      save: saveMock
    }
    Essay.findById.mockResolvedValue(existingEssay)

    const { req, res, next } = createMockContext({
      params: { id: 'essay_51_1' },
      body: { title: 'Updated Draft Title', content: 'Updated content paragraph' }
    })

    await updateEssay(req, res, next)

    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.data.success).toBe(true)
    expect(existingEssay.title).toBe('Updated Draft Title')
    expect(saveMock).toHaveBeenCalled()
  })

  it('UTCID02 (A): should reject saving draft owned by another user (403)', async () => {
    const existingEssay = {
      _id: 'essay_51_2',
      student: 'other_student_99',
      status: 'draft'
    }
    Essay.findById.mockResolvedValue(existingEssay)

    const { req, res, next } = createMockContext({
      params: { id: 'essay_51_2' },
      body: { title: 'Unauthorized Edit' }
    })

    await updateEssay(req, res, next)

    expect(next).toHaveBeenCalled()
    const err = next.mock.calls[0][0]
    expect(err.statusCode).toBe(403)
    expect(err.message).toBe('Not authorized to update this essay')
  })

  it('UTCID03 (A): should return 404 if draft essay is not found', async () => {
    Essay.findById.mockResolvedValue(null)

    const { req, res, next } = createMockContext({
      params: { id: 'non_existent_id' },
      body: { title: 'Test' }
    })

    await updateEssay(req, res, next)

    expect(next).toHaveBeenCalled()
    const err = next.mock.calls[0][0]
    expect(err.statusCode).toBe(404)
    expect(err.message).toBe('Essay not found')
  })

  it('UTCID04 (A): should reject editing draft when linked assignment is closed (400)', async () => {
    const existingEssay = {
      _id: 'essay_51_4',
      student: 'student_1',
      assignment: 'assign_closed_1',
      status: 'draft'
    }
    Essay.findById.mockResolvedValue(existingEssay)
    Assignment.findById.mockResolvedValue({
      _id: 'assign_closed_1',
      status: 'closed',
      dueDate: new Date(Date.now() - 10000)
    })

    const { req, res, next } = createMockContext({
      params: { id: 'essay_51_4' },
      body: { content: 'Trying to update closed assignment draft' }
    })

    await updateEssay(req, res, next)

    expect(next).toHaveBeenCalled()
    const err = next.mock.calls[0][0]
    expect(err.statusCode).toBe(400)
    expect(err.message).toBe('This assignment is closed and no longer accepting edits.')
  })

  it('UTCID05 (B): should allow partial update when only updating theme or title', async () => {
    const saveMock = vi.fn().mockResolvedValue(true)
    const existingEssay = {
      _id: 'essay_51_5',
      student: 'student_1',
      title: 'Original Title',
      content: 'Original Content',
      theme: 'General',
      status: 'draft',
      save: saveMock
    }
    Essay.findById.mockResolvedValue(existingEssay)

    const { req, res, next } = createMockContext({
      params: { id: 'essay_51_5' },
      body: { theme: 'Environment' }
    })

    await updateEssay(req, res, next)

    expect(res.status).toHaveBeenCalledWith(200)
    expect(existingEssay.theme).toBe('Environment')
    expect(existingEssay.content).toBe('Original Content')
  })

  it('UTCID06 (A) [LEARN-01]: should reject editing draft when student is not enrolled in assignment class (403)', async () => {
    const existingEssay = {
      _id: 'essay_51_6',
      student: 'student_1',
      assignment: 'assign_other_class',
      status: 'draft',
      save: vi.fn(),
    }
    Essay.findById.mockResolvedValue(existingEssay)
    Assignment.findById.mockResolvedValue({
      _id: 'assign_other_class',
      status: 'active',
      dueDate: new Date(Date.now() + 86400000),
      classId: 'class_other',
    })
    Class.findById.mockResolvedValue({
      _id: 'class_other',
      status: 'active',
      students: ['student_other_99'],
    })

    const { req, res, next } = createMockContext({
      params: { id: 'essay_51_6' },
      user: { _id: 'student_1', role: 'student' },
      body: { content: 'Trying to update un-enrolled assignment' },
    })

    await updateEssay(req, res, next)

    expect(next).toHaveBeenCalled()
    const err = next.mock.calls[0][0]
    expect(err.statusCode).toBe(403)
  })

  it('UTCID07 (N) [LEARN-01]: should bind essay.class to assignment.classId when updating assignment essay', async () => {
    const saveMock = vi.fn().mockResolvedValue(true)
    const existingEssay = {
      _id: 'essay_51_7',
      student: 'student_1',
      status: 'draft',
      class: 'old_class',
      save: saveMock,
    }
    Essay.findById.mockResolvedValue(existingEssay)
    Assignment.findById.mockResolvedValue({
      _id: 'assign_enrolled',
      status: 'active',
      dueDate: new Date(Date.now() + 86400000),
      classId: 'class_enrolled_real',
    })
    Class.findById.mockResolvedValue({
      _id: 'class_enrolled_real',
      status: 'active',
      students: ['student_1'],
    })

    const { req, res, next } = createMockContext({
      params: { id: 'essay_51_7' },
      user: { _id: 'student_1', role: 'student' },
      body: {
        assignmentId: 'assign_enrolled',
        classId: 'fake_class_from_client',
        title: 'Updated Assignment Essay',
      },
    })

    await updateEssay(req, res, next)

    expect(res.status).toHaveBeenCalledWith(200)
    expect(existingEssay.assignment).toBe('assign_enrolled')
    expect(existingEssay.class).toBe('class_enrolled_real')
    expect(saveMock).toHaveBeenCalled()
  })
})

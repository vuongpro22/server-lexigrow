import { vi, describe, it, expect, beforeEach } from 'vitest'
import { createMockContext } from './testHelper.js'

vi.mock('../../src/config/db.js', () => ({
  default: vi.fn().mockImplementation(() => Promise.resolve())
}))

vi.mock('../../src/models/Essay.js', () => ({
  default: {
    create: vi.fn(),
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
import { createEssay } from '../../src/controllers/essay.controller.js'

describe('F50: Create Essay (createEssay)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('UTCID01 (N): should create a new essay draft successfully for free topic', async () => {
    const mockCreatedEssay = {
      _id: 'essay_50_1',
      title: 'My Experience in AI',
      content: 'Writing about technology.',
      theme: 'Technology',
      status: 'draft',
      student: 'student_1'
    }
    Essay.create.mockResolvedValue(mockCreatedEssay)

    const { req, res, next } = createMockContext({
      body: { title: 'My Experience in AI', content: 'Writing about technology.', theme: 'Technology' }
    })

    await createEssay(req, res, next)

    expect(res.status).toHaveBeenCalledWith(201)
    expect(res.data.success).toBe(true)
    expect(res.data.data.title).toBe('My Experience in AI')
    expect(res.data.data.status).toBe('draft')
  })

  it('UTCID02 (N): should create essay linked to an active open assignment', async () => {
    Assignment.findById.mockResolvedValue({
      _id: 'assign_active',
      status: 'active',
      dueDate: new Date(Date.now() + 86400000),
      classId: 'class_active',
    })
    Class.findById.mockResolvedValue({
      _id: 'class_active',
      status: 'active',
      students: ['student_1'],
    })
    const mockCreatedEssay = {
      _id: 'essay_50_2',
      title: 'Class Assignment 1',
      content: 'Content here',
      assignment: 'assign_active',
      class: 'class_active',
      status: 'draft',
    }
    Essay.create.mockResolvedValue(mockCreatedEssay)

    const { req, res, next } = createMockContext({
      user: { _id: 'student_1', role: 'student' },
      body: { title: 'Class Assignment 1', content: 'Content here', assignmentId: 'assign_active' },
    })

    await createEssay(req, res, next)

    expect(res.status).toHaveBeenCalledWith(201)
    expect(res.data.data.assignment).toBe('assign_active')
  })

  it('UTCID03 (A): should reject creating essay for closed assignment (400)', async () => {
    Assignment.findById.mockResolvedValue({
      _id: 'assign_closed',
      status: 'closed',
      dueDate: new Date(Date.now() - 86400000)
    })

    const { req, res, next } = createMockContext({
      body: { title: 'Late Submission', assignmentId: 'assign_closed' }
    })

    await createEssay(req, res, next)

    expect(next).toHaveBeenCalled()
    const err = next.mock.calls[0][0]
    expect(err.statusCode).toBe(400)
    expect(err.message).toBe('This assignment is closed and no longer accepting submissions.')
  })

  it('UTCID04 (B): should create a new draft with empty content', async () => {
    const mockCreatedEssay = {
      _id: 'essay_50_4',
      title: 'Draft Title Only',
      content: '',
      status: 'draft'
    }
    Essay.create.mockResolvedValue(mockCreatedEssay)

    const { req, res, next } = createMockContext({
      body: { title: 'Draft Title Only' }
    })

    await createEssay(req, res, next)

    expect(res.status).toHaveBeenCalledWith(201)
    expect(res.data.data.content).toBe('')
  })

  it('UTCID05 (B): should fallback theme to General if theme is omitted', async () => {
    let capturedCreateArgs
    Essay.create.mockImplementation((args) => {
      capturedCreateArgs = args
      return Promise.resolve({ _id: 'essay_50_5', ...args })
    })

    const { req, res, next } = createMockContext({
      body: { title: 'Essay Without Theme' }
    })

    await createEssay(req, res, next)

    expect(res.status).toHaveBeenCalledWith(201)
    expect(capturedCreateArgs.theme).toBe('General')
  })

  it('UTCID06 (A) [LEARN-01]: should reject creating essay if student is not enrolled in assignment class (403)', async () => {
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
      user: { _id: 'student_1', role: 'student' },
      body: { title: 'Essay in Wrong Class', assignmentId: 'assign_other_class' },
    })

    await createEssay(req, res, next)

    expect(next).toHaveBeenCalled()
    const err = next.mock.calls[0][0]
    expect(err.statusCode).toBe(403)
    expect(err.message).toContain('Not authorized: You are not enrolled')
  })

  it('UTCID07 (A) [LEARN-01]: should reject creating essay if assignment class is archived/inactive (403)', async () => {
    Assignment.findById.mockResolvedValue({
      _id: 'assign_archived_class',
      status: 'active',
      dueDate: new Date(Date.now() + 86400000),
      classId: 'class_archived',
    })
    Class.findById.mockResolvedValue({
      _id: 'class_archived',
      status: 'archived',
      students: ['student_1'],
    })

    const { req, res, next } = createMockContext({
      user: { _id: 'student_1', role: 'student' },
      body: { title: 'Archived Class Essay', assignmentId: 'assign_archived_class' },
    })

    await createEssay(req, res, next)

    expect(next).toHaveBeenCalled()
    const err = next.mock.calls[0][0]
    expect(err.statusCode).toBe(403)
  })

  it('UTCID08 (N) [LEARN-01]: should bind essay.class to assignment.classId and ignore client-sent classId', async () => {
    Assignment.findById.mockResolvedValue({
      _id: 'assign_valid',
      status: 'active',
      dueDate: new Date(Date.now() + 86400000),
      classId: 'class_real',
    })
    Class.findById.mockResolvedValue({
      _id: 'class_real',
      status: 'active',
      students: ['student_1'],
    })

    let capturedArgs
    Essay.create.mockImplementation((args) => {
      capturedArgs = args
      return Promise.resolve({ _id: 'essay_50_8', ...args })
    })

    const { req, res, next } = createMockContext({
      user: { _id: 'student_1', role: 'student' },
      body: {
        title: 'Tampered ClassId Test',
        assignmentId: 'assign_valid',
        classId: 'class_spoofed_by_client',
      },
    })

    await createEssay(req, res, next)

    expect(res.status).toHaveBeenCalledWith(201)
    expect(capturedArgs.class).toBe('class_real')
    expect(capturedArgs.assignment).toBe('assign_valid')
  })

  it('UTCID09 (N) [LEARN-22]: should strip HTML tags and store plain text in createEssay', async () => {
    let capturedArgs
    Essay.create.mockImplementation((args) => {
      capturedArgs = args
      return Promise.resolve({ _id: 'essay_plain', ...args })
    })

    const { req, res, next } = createMockContext({
      user: { _id: 'student_1', role: 'student' },
      body: {
        title: 'Rich Editor Essay',
        content: '<p>First paragraph with <b>bold</b> text.</p><br><div>Second paragraph with &nbsp;spaces.</div>',
        theme: 'Technology',
      },
    })

    await createEssay(req, res, next)

    expect(res.status).toHaveBeenCalledWith(201)
    expect(capturedArgs.content).not.toContain('<p>')
    expect(capturedArgs.content).not.toContain('<b>')
    expect(capturedArgs.content).not.toContain('</div>')
    expect(capturedArgs.content).toBe('First paragraph with bold text.\n\n\nSecond paragraph with  spaces.')
  })
})

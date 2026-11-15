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

vi.mock('../../src/models/Notification.js', () => ({
  default: {
    create: vi.fn().mockResolvedValue(true),
  }
}))

vi.mock('../../src/utils/essayAccess.js', () => ({
  canAccessEssay: vi.fn().mockResolvedValue(true)
}))

vi.mock('../../src/services/socket.service.js', () => ({
  getIO: vi.fn().mockReturnValue({
    to: vi.fn().mockReturnValue({
      emit: vi.fn()
    })
  })
}))

import Essay from '../../src/models/Essay.js'
import { requestRevision } from '../../src/controllers/essay.controller.js'
import { canAccessEssay } from '../../src/utils/essayAccess.js'

describe('F68: Request Essay Revision (requestRevision)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    canAccessEssay.mockResolvedValue(true)
  })

  it('UTCID01 (N): should allow teacher to request essay revision', async () => {
    const saveMock = vi.fn().mockResolvedValue(true)
    const existingEssay = {
      _id: 'e_rev_1',
      title: 'Essay on Science',
      student: 'student_1',
      status: 'reviewed',
      save: saveMock
    }
    Essay.findById.mockResolvedValue(existingEssay)

    const { req, res, next } = createMockContext({
      params: { id: 'e_rev_1' },
      user: { _id: 'teacher_1', role: 'teacher' }
    })

    await requestRevision(req, res, next)

    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.data.success).toBe(true)
    expect(existingEssay.status).toBe('needs_revision')
    expect(res.data.message).toBe('Revision requested successfully')
    expect(saveMock).toHaveBeenCalled()
  })

  it('UTCID02 (A): should reject revision request by non-teacher (403)', async () => {
    const { req, res, next } = createMockContext({
      params: { id: 'e_rev_2' },
      user: { _id: 'student_1', role: 'student' }
    })

    await requestRevision(req, res, next)

    expect(next).toHaveBeenCalled()
    const err = next.mock.calls[0][0]
    expect(err.statusCode).toBe(403)
    expect(err.message).toBe('Not authorized: teachers only')
  })

  it('UTCID03 (A): should return 404 if essay is not found', async () => {
    Essay.findById.mockResolvedValue(null)

    const { req, res, next } = createMockContext({
      params: { id: 'non_existent_essay' },
      user: { _id: 'teacher_1', role: 'teacher' }
    })

    await requestRevision(req, res, next)

    expect(next).toHaveBeenCalled()
    const err = next.mock.calls[0][0]
    expect(err.statusCode).toBe(404)
    expect(err.message).toBe('Essay not found')
  })

  it('UTCID04 (A): should reject teacher if student is not in teacher classes (403)', async () => {
    const existingEssay = {
      _id: 'e_rev_4',
      title: 'Essay of other student',
      student: 'student_99'
    }
    Essay.findById.mockResolvedValue(existingEssay)
    canAccessEssay.mockResolvedValue(false)

    const { req, res, next } = createMockContext({
      params: { id: 'e_rev_4' },
      user: { _id: 'teacher_1', role: 'teacher' }
    })

    await requestRevision(req, res, next)

    expect(next).toHaveBeenCalled()
    const err = next.mock.calls[0][0]
    expect(err.statusCode).toBe(403)
    expect(err.message).toBe('Not authorized to request revision for this essay')
  })

  it('UTCID05 (B): should allow revision request on newly submitted essay (status: "submitted")', async () => {
    const saveMock = vi.fn().mockResolvedValue(true)
    const existingEssay = {
      _id: 'e_rev_5',
      title: 'Essay freshly submitted',
      student: 'student_1',
      status: 'submitted',
      save: saveMock
    }
    Essay.findById.mockResolvedValue(existingEssay)

    const { req, res, next } = createMockContext({
      params: { id: 'e_rev_5' },
      user: { _id: 'teacher_1', role: 'teacher' }
    })

    await requestRevision(req, res, next)

    expect(res.status).toHaveBeenCalledWith(200)
    expect(existingEssay.status).toBe('needs_revision')
    expect(saveMock).toHaveBeenCalled()
  })
})

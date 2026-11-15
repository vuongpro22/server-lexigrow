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

vi.mock('../../src/services/ai.service.js', () => ({
  processEssayAnalysis: vi.fn().mockResolvedValue({}),
}))

import Essay from '../../src/models/Essay.js'
import { deleteEssay } from '../../src/controllers/essay.controller.js'

describe('F55: Delete Essay (deleteEssay)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('UTCID01 (N): should delete a draft essay owned by current student', async () => {
    const deleteOneMock = vi.fn().mockResolvedValue(true)
    const existingEssay = {
      _id: 'e_del_1',
      student: 'student_1',
      status: 'draft',
      deleteOne: deleteOneMock
    }
    Essay.findById.mockResolvedValue(existingEssay)

    const { req, res, next } = createMockContext({
      params: { id: 'e_del_1' }
    })

    await deleteEssay(req, res, next)

    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.data.success).toBe(true)
    expect(res.data.message).toBe('Essay deleted')
    expect(deleteOneMock).toHaveBeenCalled()
  })

  it('UTCID02 (A): should reject deleting a submitted essay (400)', async () => {
    const existingEssay = {
      _id: 'e_del_2',
      student: 'student_1',
      status: 'submitted'
    }
    Essay.findById.mockResolvedValue(existingEssay)

    const { req, res, next } = createMockContext({
      params: { id: 'e_del_2' }
    })

    await deleteEssay(req, res, next)

    expect(next).toHaveBeenCalled()
    const err = next.mock.calls[0][0]
    expect(err.statusCode).toBe(400)
    expect(err.message).toBe('Cannot delete a submitted or reviewed essay')
  })

  it('UTCID02b (A) [LEARN-03]: should reject deleting a reviewed essay (400)', async () => {
    const existingEssay = {
      _id: 'e_del_reviewed',
      student: 'student_1',
      status: 'reviewed'
    }
    Essay.findById.mockResolvedValue(existingEssay)

    const { req, res, next } = createMockContext({
      params: { id: 'e_del_reviewed' }
    })

    await deleteEssay(req, res, next)

    expect(next).toHaveBeenCalled()
    const err = next.mock.calls[0][0]
    expect(err.statusCode).toBe(400)
    expect(err.message).toBe('Cannot delete a submitted or reviewed essay')
  })

  it('UTCID02c (A) [LEARN-03]: should reject deleting a needs_revision essay (400)', async () => {
    const existingEssay = {
      _id: 'e_del_revision',
      student: 'student_1',
      status: 'needs_revision'
    }
    Essay.findById.mockResolvedValue(existingEssay)

    const { req, res, next } = createMockContext({
      params: { id: 'e_del_revision' }
    })

    await deleteEssay(req, res, next)

    expect(next).toHaveBeenCalled()
    const err = next.mock.calls[0][0]
    expect(err.statusCode).toBe(400)
    expect(err.message).toBe('Cannot delete a submitted or reviewed essay')
  })

  it('UTCID03 (A): should reject deleting an essay owned by someone else (403)', async () => {
    const existingEssay = {
      _id: 'e_del_3',
      student: 'other_student',
      status: 'draft'
    }
    Essay.findById.mockResolvedValue(existingEssay)

    const { req, res, next } = createMockContext({
      params: { id: 'e_del_3' }
    })

    await deleteEssay(req, res, next)

    expect(next).toHaveBeenCalled()
    const err = next.mock.calls[0][0]
    expect(err.statusCode).toBe(403)
    expect(err.message).toBe('Not authorized')
  })

  it('UTCID04 (A): should return 404 if essay to delete does not exist', async () => {
    Essay.findById.mockResolvedValue(null)

    const { req, res, next } = createMockContext({
      params: { id: 'ghost_essay' }
    })

    await deleteEssay(req, res, next)

    expect(next).toHaveBeenCalled()
    const err = next.mock.calls[0][0]
    expect(err.statusCode).toBe(404)
    expect(err.message).toBe('Essay not found')
  })
})

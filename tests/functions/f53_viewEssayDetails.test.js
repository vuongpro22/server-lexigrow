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

vi.mock('../../src/utils/essayAccess.js', () => ({
  canAccessEssay: vi.fn().mockResolvedValue(true)
}))

import Essay from '../../src/models/Essay.js'
import { getEssay } from '../../src/controllers/essay.controller.js'
import { canAccessEssay } from '../../src/utils/essayAccess.js'

describe('F53: View Essay Details (getEssay)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    canAccessEssay.mockResolvedValue(true)
  })

  it('UTCID01 (N): should return essay details when authorized student accesses own essay', async () => {
    const mockEssay = {
      _id: 'e_detail_1',
      title: 'Detailed Essay',
      student: { _id: 'student_1', name: 'Student One', email: 's1@test.com' }
    }
    Essay.findById.mockReturnValue({
      populate: vi.fn().mockResolvedValue(mockEssay)
    })

    const { req, res, next } = createMockContext({
      params: { id: 'e_detail_1' },
      user: { _id: 'student_1', role: 'student' }
    })

    await getEssay(req, res, next)

    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.data.success).toBe(true)
    expect(res.data.data.title).toBe('Detailed Essay')
  })

  it('UTCID02 (N): should allow authorized teacher to view student essay', async () => {
    const mockEssay = {
      _id: 'e_detail_2',
      title: 'Student Essay for Teacher',
      student: { _id: 'student_1', name: 'Student One' }
    }
    Essay.findById.mockReturnValue({
      populate: vi.fn().mockResolvedValue(mockEssay)
    })
    canAccessEssay.mockResolvedValue(true)

    const { req, res, next } = createMockContext({
      params: { id: 'e_detail_2' },
      user: { _id: 'teacher_1', role: 'teacher' }
    })

    await getEssay(req, res, next)

    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.data.data.title).toBe('Student Essay for Teacher')
  })

  it('UTCID03 (A): should return 404 when essay not found', async () => {
    Essay.findById.mockReturnValue({
      populate: vi.fn().mockResolvedValue(null)
    })

    const { req, res, next } = createMockContext({
      params: { id: 'unknown_id' }
    })

    await getEssay(req, res, next)

    expect(next).toHaveBeenCalled()
    const err = next.mock.calls[0][0]
    expect(err.statusCode).toBe(404)
    expect(err.message).toBe('Essay not found')
  })

  it('UTCID04 (A): should return 403 if user is unauthorized (BOLA protection)', async () => {
    const mockEssay = { _id: 'e_detail_4', student: 'other_user' }
    Essay.findById.mockReturnValue({
      populate: vi.fn().mockResolvedValue(mockEssay)
    })
    canAccessEssay.mockResolvedValue(false)

    const { req, res, next } = createMockContext({
      params: { id: 'e_detail_4' }
    })

    await getEssay(req, res, next)

    expect(next).toHaveBeenCalled()
    const err = next.mock.calls[0][0]
    expect(err.statusCode).toBe(403)
    expect(err.message).toBe('Not authorized to access this essay')
  })
})

import { vi, describe, it, expect, beforeEach } from 'vitest'
import { createMockContext, mockQuery } from './testHelper.js'

vi.mock('../../src/config/db.js', () => ({
  default: vi.fn().mockImplementation(() => Promise.resolve())
}))

vi.mock('../../src/models/Essay.js', () => ({
  default: {
    find: vi.fn(),
    countDocuments: vi.fn(),
  }
}))

vi.mock('../../src/utils/essayAccess.js', () => ({
  essayVisibilityFilter: vi.fn().mockResolvedValue({})
}))

import Essay from '../../src/models/Essay.js'
import { getEssays } from '../../src/controllers/essay.controller.js'
import { essayVisibilityFilter } from '../../src/utils/essayAccess.js'

describe('F52: View Essay History (getEssays)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    essayVisibilityFilter.mockResolvedValue({})
  })

  it('UTCID01 (N): should retrieve essay history for student with default pagination', async () => {
    const mockList = [
      { _id: 'e1', title: 'Essay 1', status: 'submitted' },
      { _id: 'e2', title: 'Essay 2', status: 'draft' }
    ]
    Essay.find.mockReturnValue(mockQuery(mockList))
    Essay.countDocuments.mockResolvedValue(2)

    const { req, res, next } = createMockContext({
      query: { page: '1', limit: '20' }
    })

    await getEssays(req, res, next)

    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.data.success).toBe(true)
    expect(res.data.count).toBe(2)
    expect(res.data.pages).toBe(1)
  })

  it('UTCID02 (N): should filter essay list by status (e.g. status=draft)', async () => {
    const draftList = [{ _id: 'e2', title: 'Essay 2', status: 'draft' }]
    let capturedQuery
    Essay.find.mockImplementation((q) => {
      capturedQuery = q
      return mockQuery(draftList)
    })
    Essay.countDocuments.mockResolvedValue(1)

    const { req, res, next } = createMockContext({
      query: { status: 'draft' }
    })

    await getEssays(req, res, next)

    expect(res.status).toHaveBeenCalledWith(200)
    expect(capturedQuery.status).toBe('draft')
    expect(res.data.count).toBe(1)
  })

  it('UTCID03 (A): should return 403 if visibility filter denies access', async () => {
    essayVisibilityFilter.mockResolvedValue(null)

    const { req, res, next } = createMockContext()

    await getEssays(req, res, next)

    expect(next).toHaveBeenCalled()
    const err = next.mock.calls[0][0]
    expect(err.statusCode).toBe(403)
    expect(err.message).toBe('Not authorized to view essays')
  })

  it('UTCID04 (B): should handle boundary page out of bounds returning empty data', async () => {
    Essay.find.mockReturnValue(mockQuery([]))
    Essay.countDocuments.mockResolvedValue(5)

    const { req, res, next } = createMockContext({
      query: { page: '99', limit: '10' }
    })

    await getEssays(req, res, next)

    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.data.count).toBe(0)
    expect(res.data.data).toEqual([])
  })
})

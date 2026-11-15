import { vi, describe, it, expect, beforeEach } from 'vitest'
import { createMockContext } from './testHelper.js'

vi.mock('../../src/config/db.js', () => ({
  default: vi.fn().mockImplementation(() => Promise.resolve())
}))

vi.mock('../../src/models/Essay.js', () => ({
  default: {
    find: vi.fn(),
  }
}))

vi.mock('../../src/services/ai.service.js', () => ({
  generateTopicsByTheme: vi.fn().mockImplementation((theme, existing) => {
    return Promise.resolve([
      `AI and ${theme}`,
      `Future perspectives on ${theme}`,
      `Challenges facing ${theme}`
    ])
  })
}))

import Essay from '../../src/models/Essay.js'
import { getSuggestedTopics } from '../../src/controllers/essay.controller.js'
import { generateTopicsByTheme } from '../../src/services/ai.service.js'

describe('F57: Receive AI Topic Suggestions (getSuggestedTopics)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('UTCID01 (N): should return suggested topics for a given theme', async () => {
    Essay.find.mockReturnValue({
      select: vi.fn().mockReturnValue({
        sort: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([{ title: 'Old Essay' }])
        })
      })
    })

    const { req, res, next } = createMockContext({
      query: { theme: 'Technology' }
    })

    await getSuggestedTopics(req, res, next)

    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.data.success).toBe(true)
    expect(Array.isArray(res.data.data)).toBe(true)
    expect(res.data.data.length).toBe(3)
  })

  it('UTCID02 (N): should pass student existing essay titles to avoid duplicate suggestions', async () => {
    Essay.find.mockReturnValue({
      select: vi.fn().mockReturnValue({
        sort: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([{ title: 'Essay A' }, { title: 'Essay B' }])
        })
      })
    })

    const { req, res, next } = createMockContext({
      query: { theme: 'Education' }
    })

    await getSuggestedTopics(req, res, next)

    expect(generateTopicsByTheme).toHaveBeenCalledWith('Education', ['Essay A', 'Essay B'])
    expect(res.status).toHaveBeenCalledWith(200)
  })

  it('UTCID03 (A): should return 400 if theme query parameter is omitted', async () => {
    const { req, res, next } = createMockContext({
      query: {}
    })

    await getSuggestedTopics(req, res, next)

    expect(next).toHaveBeenCalled()
    const err = next.mock.calls[0][0]
    expect(err.statusCode).toBe(400)
    expect(err.message).toBe('Please provide a theme in the query parameters')
  })

  it('UTCID04 (B): should return 400 if theme query parameter is an empty string', async () => {
    const { req, res, next } = createMockContext({
      query: { theme: '' }
    })

    await getSuggestedTopics(req, res, next)

    expect(next).toHaveBeenCalled()
    const err = next.mock.calls[0][0]
    expect(err.statusCode).toBe(400)
    expect(err.message).toBe('Please provide a theme in the query parameters')
  })
})

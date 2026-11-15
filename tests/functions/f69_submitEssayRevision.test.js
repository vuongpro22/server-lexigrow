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

vi.mock('../../src/models/Class.js', () => ({
  default: {
    findById: vi.fn().mockReturnValue({ select: vi.fn().mockResolvedValue(null) }),
    findOne: vi.fn().mockReturnValue({ select: vi.fn().mockReturnValue({ sort: vi.fn().mockResolvedValue(null) }) })
  }
}))

vi.mock('../../src/models/SystemPrompt.js', () => ({
  default: {
    findOne: vi.fn().mockReturnValue({ sort: vi.fn().mockResolvedValue(null) })
  }
}))

vi.mock('../../src/services/ai.service.js', () => ({
  processEssayAnalysis: vi.fn().mockResolvedValue({}),
}))

vi.mock('../../src/services/tier.service.js', () => ({
  checkDailyEssayQuota: vi.fn().mockResolvedValue({ canSubmit: true, limit: 3 }),
}))
vi.mock('../../src/services/aiQuota.js', () => ({
  reserveDailyEssayQuota: vi.fn().mockResolvedValue({ reserved: true, day: '2026-11-10' }),
  settleDailyEssayQuota: vi.fn().mockResolvedValue({ settled: true }),
}))
vi.mock('../../src/services/aiQuota.service.js', () => ({
  checkDailyEssayQuota: vi.fn().mockResolvedValue({ canSubmit: true, limit: 3 }),
}))
vi.mock('../../src/services/aiQuota.js', () => ({
  reserveDailyEssayQuota: vi.fn().mockResolvedValue({ reserved: true, day: '2026-11-10' }),
  settleDailyEssayQuota: vi.fn().mockResolvedValue({ settled: true }),
}))
vi.mock('../../src/services/aiQuota.service.js', () => ({
  checkDailyEssayQuota: vi.fn().mockResolvedValue({ canSubmit: true, limit: 3 }),
}))

import Essay from '../../src/models/Essay.js'
import { reserveDailyEssayQuota } from '../../src/services/aiQuota.js'
import { submitEssay } from '../../src/controllers/essay.controller.js'

describe('F69: Submit Essay Revision (submitEssay with needs_revision)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('UTCID01 (N): should allow student to submit an essay currently in needs_revision status', async () => {
    const saveMock = vi.fn().mockResolvedValue(true)
    const revisedEssay = {
      _id: 'e_rev_submit_1',
      student: 'student_1',
      status: 'needs_revision',
      content: Array(55).fill('revised').join(' '),
      wordCount: 55,
      save: saveMock
    }
    Essay.findById.mockResolvedValue(revisedEssay)

    const { req, res, next } = createMockContext({
      params: { id: 'e_rev_submit_1' },
      user: { _id: 'student_1', role: 'student' }
    })

    await submitEssay(req, res, next)

    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.data.success).toBe(true)
    expect(revisedEssay.status).toBe('submitted')
    expect(res.data.message).toBe('Essay submitted successfully')
    expect(saveMock).toHaveBeenCalled()
  })

  it('UTCID02 (B): should reject submitting revision if wordCount is less than 50 words', async () => {
    const revisedEssay = {
      _id: 'e_rev_submit_2',
      student: 'student_1',
      status: 'needs_revision',
      content: 'Short revised text',
      wordCount: 3
    }
    Essay.findById.mockResolvedValue(revisedEssay)

    const { req, res, next } = createMockContext({
      params: { id: 'e_rev_submit_2' },
      user: { _id: 'student_1', role: 'student' }
    })

    await submitEssay(req, res, next)

    expect(next).toHaveBeenCalled()
    const err = next.mock.calls[0][0]
    expect(err.statusCode).toBe(400)
    expect(err.message).toBe('Essay must have at least 50 words to submit')
  })

  it('UTCID03 (A): should reject revision submission by another student (403)', async () => {
    const revisedEssay = {
      _id: 'e_rev_submit_3',
      student: 'other_student_id',
      status: 'needs_revision',
      content: Array(55).fill('revised').join(' '),
      wordCount: 55
    }
    Essay.findById.mockResolvedValue(revisedEssay)

    const { req, res, next } = createMockContext({
      params: { id: 'e_rev_submit_3' },
      user: { _id: 'student_1', role: 'student' }
    })

    await submitEssay(req, res, next)

    expect(next).toHaveBeenCalled()
    const err = next.mock.calls[0][0]
    expect(err.statusCode).toBe(403)
    expect(err.message).toBe('Not authorized')
  })

  it('UTCID04 (A): should return 404 if revised essay is not found in database', async () => {
    Essay.findById.mockResolvedValue(null)

    const { req, res, next } = createMockContext({
      params: { id: 'non_existent_essay' },
      user: { _id: 'student_1', role: 'student' }
    })

    await submitEssay(req, res, next)

    expect(next).toHaveBeenCalled()
    const err = next.mock.calls[0][0]
    expect(err.statusCode).toBe(404)
    expect(err.message).toBe('Essay not found')
  })

  it('UTCID05 (A): should reject revision if essay is already submitted', async () => {
    const essay = {
      _id: 'e_rev_submit_5',
      student: 'student_1',
      status: 'submitted',
      content: Array(55).fill('revised').join(' '),
      wordCount: 55
    }
    Essay.findById.mockResolvedValue(essay)

    const { req, res, next } = createMockContext({
      params: { id: 'e_rev_submit_5' },
      user: { _id: 'student_1', role: 'student' }
    })

    await submitEssay(req, res, next)

    expect(next).toHaveBeenCalled()
    const err = next.mock.calls[0][0]
    expect(err.statusCode).toBe(400)
    expect(err.message).toBe('Essay already submitted')
  })

  it('UTCID06 (A) [LEARN-23]: should reject revision submit with 429 DAILY_ESSAY_LIMIT_REACHED when daily quota is exceeded', async () => {
    reserveDailyEssayQuota.mockResolvedValueOnce({
      reserved: false,
      tierInfo: { dailyAiEssayLimit: 3 },
    })

    const essay = {
      _id: 'e_rev_quota_exceeded',
      student: 'student_1',
      status: 'needs_revision',
      content: Array(55).fill('revised').join(' '),
      wordCount: 55,
      save: vi.fn(),
    }
    Essay.findById.mockResolvedValue(essay)

    const { req, res, next } = createMockContext({
      params: { id: 'e_rev_quota_exceeded' },
      user: { _id: 'student_1', role: 'student' },
    })

    await submitEssay(req, res, next)

    expect(next).toHaveBeenCalled()
    const err = next.mock.calls[0][0]
    expect(err.statusCode).toBe(429)
    expect(err.code).toBe('DAILY_ESSAY_LIMIT_REACHED')
    expect(err.message).toContain('Daily AI essay limit reached (3)')
    expect(essay.status).toBe('needs_revision')
    expect(essay.save).not.toHaveBeenCalled()
  })
})

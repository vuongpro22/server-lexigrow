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
  processEssayAnalysis: vi.fn().mockResolvedValue({
    _id: 'mock_reanalysis_id',
    scores: { overallBand: 7.5 }
  })
}))

vi.mock('../../src/services/aiQuota.js', () => ({
  reserveDailyEssayQuota: vi.fn().mockResolvedValue({ reserved: true, day: '2026-11-11', tierInfo: { dailyAiEssayLimit: 3 } }),
  settleDailyEssayQuota: vi.fn().mockResolvedValue({ settled: true }),
}))

import Essay from '../../src/models/Essay.js'
import { processEssayAnalysis } from '../../src/services/ai.service.js'
import { reserveDailyEssayQuota } from '../../src/services/aiQuota.js'
import { reanalyze } from '../../src/controllers/analysis.controller.js'

describe('F61: Reanalyze Essay (reanalyze)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('UTCID01 (N): should trigger reanalyze for submitted essay and mark reviewed', async () => {
    const saveMock = vi.fn().mockResolvedValue(true)
    const existingEssay = {
      _id: 'e_re_1',
      student: 'student_1',
      content: 'Long essay text for analysis',
      status: 'submitted',
      save: saveMock
    }
    Essay.findById.mockResolvedValue(existingEssay)

    const { req, res, next } = createMockContext({
      params: { essayId: 'e_re_1' }
    })

    await reanalyze(req, res, next)

    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.data.success).toBe(true)
    expect(existingEssay.status).toBe('reviewed')
    expect(saveMock).toHaveBeenCalled()
  })

  it('UTCID02 (N): should allow reanalyzing an already reviewed essay (re-scoring)', async () => {
    const saveMock = vi.fn().mockResolvedValue(true)
    const existingEssay = {
      _id: 'e_re_2',
      student: 'student_1',
      content: 'Second analysis run',
      status: 'reviewed',
      save: saveMock
    }
    Essay.findById.mockResolvedValue(existingEssay)

    const { req, res, next } = createMockContext({
      params: { essayId: 'e_re_2' }
    })

    await reanalyze(req, res, next)

    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.data.data.scores.overallBand).toBe(7.5)
  })

  // AI-12: the key must be deterministic per essay revision so a retried request
  // reuses the provider's stored grading instead of paying for a second one.
  it('reuses one deterministic AI idempotency key for the same essay revision', async () => {
    const existingEssay = {
      _id: 'e_repeated',
      student: 'student_1',
      content: 'Same essay content',
      status: 'reviewed',
      revisionCounter: 2,
      save: vi.fn().mockResolvedValue(true),
    }
    Essay.findById.mockResolvedValue(existingEssay)

    const first = createMockContext({ params: { essayId: 'e_repeated' } })
    const second = createMockContext({ params: { essayId: 'e_repeated' } })
    await reanalyze(first.req, first.res, first.next)
    await reanalyze(second.req, second.res, second.next)

    const firstRequestId = processEssayAnalysis.mock.calls[0][5]
    const secondRequestId = processEssayAnalysis.mock.calls[1][5]
    expect(firstRequestId).toBe('essay-reanalyze:e_repeated:2')
    expect(secondRequestId).toBe(firstRequestId)
  })

  it('uses distinct AI idempotency keys when output language or custom prompt changes', async () => {
    const existingEssay = {
      _id: 'e_lang_switch',
      student: 'student_1',
      content: 'Same essay content for bilingual analysis',
      status: 'reviewed',
      revisionCounter: 2,
      save: vi.fn().mockResolvedValue(true),
    }
    Essay.findById.mockResolvedValue(existingEssay)

    const enCtx = createMockContext({ params: { essayId: 'e_lang_switch' }, body: { language: 'en' } })
    const viCtx = createMockContext({ params: { essayId: 'e_lang_switch' }, body: { language: 'vi' } })
    await reanalyze(enCtx.req, enCtx.res, enCtx.next)
    await reanalyze(viCtx.req, viCtx.res, viCtx.next)

    const enKey = processEssayAnalysis.mock.calls[0][5]
    const viKey = processEssayAnalysis.mock.calls[1][5]
    expect(enKey).toBe('essay-reanalyze:e_lang_switch:2')
    expect(viKey).toBe('essay-reanalyze:e_lang_switch:2:vi')
    expect(viKey).not.toBe(enKey)

    const { default: Class } = await import('../../src/models/Class.js')
    const { default: SystemPrompt } = await import('../../src/models/SystemPrompt.js')
    Class.findOne.mockReturnValueOnce({
      select: vi.fn().mockReturnValue({
        sort: vi.fn().mockResolvedValue({ teacher: 'teacher-1' }),
      }),
    })
    SystemPrompt.findOne.mockReturnValueOnce({
      sort: vi.fn().mockResolvedValue({ _id: 'prompt-1', name: 'Strict Rubric', template: 'Focus on cohesion' }),
    })
    const customCtx = createMockContext({ params: { essayId: 'e_lang_switch' }, body: { language: 'vi' } })
    await reanalyze(customCtx.req, customCtx.res, customCtx.next)

    const customKey = processEssayAnalysis.mock.calls[2][5]
    expect(customKey).toMatch(/^essay-reanalyze:e_lang_switch:2:vi:[a-f0-9]{8}$/)
    expect(customKey).not.toBe(viKey)
  })

  it('still bills a separate daily quota reservation per re-analysis request', async () => {
    const existingEssay = {
      _id: 'e_repeated', student: 'student_1', content: 'Same essay content',
      status: 'reviewed', revisionCounter: 0, save: vi.fn().mockResolvedValue(true),
    }
    Essay.findById.mockResolvedValue(existingEssay)

    const { reserveDailyEssayQuota } = await import('../../src/services/aiQuota.js')
    await reanalyze(createMockContext({ params: { essayId: 'e_repeated' } }).req,
      createMockContext({ params: { essayId: 'e_repeated' } }).res, () => {})
    await reanalyze(createMockContext({ params: { essayId: 'e_repeated' } }).req,
      createMockContext({ params: { essayId: 'e_repeated' } }).res, () => {})
    expect(reserveDailyEssayQuota).toHaveBeenCalledTimes(2)
  })

  it('UTCID03 (A): should reject reanalyzing a draft essay (400)', async () => {
    const draftEssay = {
      _id: 'e_re_3',
      status: 'draft'
    }
    Essay.findById.mockResolvedValue(draftEssay)

    const { req, res, next } = createMockContext({
      params: { essayId: 'e_re_3' }
    })

    await reanalyze(req, res, next)

    expect(next).toHaveBeenCalled()
    const err = next.mock.calls[0][0]
    expect(err.statusCode).toBe(400)
    expect(err.message).toBe('Cannot analyze a draft essay')
  })

  it('UTCID04 (A): should return 404 if essay does not exist', async () => {
    Essay.findById.mockResolvedValue(null)

    const { req, res, next } = createMockContext({
      params: { essayId: 'not_found' }
    })

    await reanalyze(req, res, next)

    expect(next).toHaveBeenCalled()
    const err = next.mock.calls[0][0]
    expect(err.statusCode).toBe(404)
    expect(err.message).toBe('Essay not found')
  })

  it('UTCID05 (A) [LEARN-23]: should reject reanalyze with 429 DAILY_ESSAY_LIMIT_REACHED when daily quota is exceeded', async () => {
    reserveDailyEssayQuota.mockResolvedValueOnce({
      reserved: false,
      tierInfo: { dailyAiEssayLimit: 3 },
    })

    const existingEssay = {
      _id: 'e_re_quota_exceeded',
      student: 'student_1',
      content: 'Long essay text for analysis',
      status: 'submitted',
      save: vi.fn(),
    }
    Essay.findById.mockResolvedValue(existingEssay)

    const { req, res, next } = createMockContext({
      params: { essayId: 'e_re_quota_exceeded' },
      user: { _id: 'student_1', role: 'student' },
    })

    await reanalyze(req, res, next)

    expect(next).toHaveBeenCalled()
    const err = next.mock.calls[0][0]
    expect(err.statusCode).toBe(429)
    expect(err.code).toBe('DAILY_ESSAY_LIMIT_REACHED')
    expect(err.message).toContain('Daily AI essay limit reached (3)')
    expect(existingEssay.status).toBe('submitted')
  })
})

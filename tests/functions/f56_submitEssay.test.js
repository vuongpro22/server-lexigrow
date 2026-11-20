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
vi.mock('../../src/services/notification.service.js', () => ({
  createNotification: vi.fn().mockResolvedValue({}),
}))
vi.mock('../../src/services/aiQuota.service.js', () => ({
  checkDailyEssayQuota: vi.fn().mockResolvedValue({ canSubmit: true, limit: 3 }),
}))

import Essay from '../../src/models/Essay.js'
import Assignment from '../../src/models/Assignment.js'
import Class from '../../src/models/Class.js'
import { reserveDailyEssayQuota } from '../../src/services/aiQuota.js'
import { createNotification } from '../../src/services/notification.service.js'
import { submitEssay } from '../../src/controllers/essay.controller.js'

describe('F56: Submit Essay (submitEssay)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('UTCID01 (N): should successfully submit an essay with >= 50 words', async () => {
    const saveMock = vi.fn().mockResolvedValue(true)
    const longText = Array(60).fill('word').join(' ')
    const existingEssay = {
      _id: 'e_sub_1',
      student: 'student_1',
      status: 'draft',
      content: longText,
      wordCount: 60,
      save: saveMock
    }
    Essay.findById.mockResolvedValue(existingEssay)

    const { req, res, next } = createMockContext({
      params: { id: 'e_sub_1' }
    })

    await submitEssay(req, res, next)

    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.data.success).toBe(true)
    expect(existingEssay.status).toBe('submitted')
    expect(res.data.message).toBe('Essay submitted successfully')
    expect(saveMock).toHaveBeenCalled()
  })

  it('UTCID02 (B): should submit essay with EXACTLY 50 words boundary', async () => {
    const saveMock = vi.fn().mockResolvedValue(true)
    const exactFiftyWords = Array(50).fill('word').join(' ')
    const existingEssay = {
      _id: 'e_sub_2',
      student: 'student_1',
      status: 'draft',
      content: exactFiftyWords,
      wordCount: 50,
      save: saveMock
    }
    Essay.findById.mockResolvedValue(existingEssay)

    const { req, res, next } = createMockContext({
      params: { id: 'e_sub_2' }
    })

    await submitEssay(req, res, next)

    expect(res.status).toHaveBeenCalledWith(200)
    expect(existingEssay.status).toBe('submitted')
  })

  it('UTCID03 (B): should reject submission if essay has 49 words (boundary below 50)', async () => {
    const fortyNineWords = Array(49).fill('word').join(' ')
    const existingEssay = {
      _id: 'e_sub_3',
      student: 'student_1',
      status: 'draft',
      content: fortyNineWords,
      wordCount: 49
    }
    Essay.findById.mockResolvedValue(existingEssay)

    const { req, res, next } = createMockContext({
      params: { id: 'e_sub_3' }
    })

    await submitEssay(req, res, next)

    expect(next).toHaveBeenCalled()
    const err = next.mock.calls[0][0]
    expect(err.statusCode).toBe(400)
    expect(err.message).toBe('Essay must have at least 50 words to submit')
  })

  it('UTCID04 (A): should reject submission if essay is already submitted', async () => {
    const existingEssay = {
      _id: 'e_sub_4',
      student: 'student_1',
      status: 'submitted',
      content: Array(60).fill('word').join(' '),
      wordCount: 60
    }
    Essay.findById.mockResolvedValue(existingEssay)

    const { req, res, next } = createMockContext({
      params: { id: 'e_sub_4' }
    })

    await submitEssay(req, res, next)

    expect(next).toHaveBeenCalled()
    const err = next.mock.calls[0][0]
    expect(err.statusCode).toBe(400)
    expect(err.message).toBe('Essay already submitted')
  })

  it('UTCID05 (A): should reject submission if essay belongs to another user (403)', async () => {
    const existingEssay = {
      _id: 'e_sub_5',
      student: 'other_student_id',
      status: 'draft',
      content: Array(60).fill('word').join(' '),
      wordCount: 60
    }
    Essay.findById.mockResolvedValue(existingEssay)

    const { req, res, next } = createMockContext({
      params: { id: 'e_sub_5' },
      user: { _id: 'student_1', role: 'student' }
    })

    await submitEssay(req, res, next)

    expect(next).toHaveBeenCalled()
    const err = next.mock.calls[0][0]
    expect(err.statusCode).toBe(403)
    expect(err.message).toBe('Not authorized')
  })

  it('rejects submission when the essay class is archived', async () => {
    const saveMock = vi.fn().mockResolvedValue(true)
    const existingEssay = {
      _id: 'e_sub_archived',
      student: 'student_1',
      class: 'class_archived',
      status: 'draft',
      content: Array(60).fill('word').join(' '),
      wordCount: 60,
      save: saveMock
    }
    Essay.findById.mockResolvedValue(existingEssay)
    Class.findById.mockReturnValue({
      select: vi.fn().mockResolvedValue({ _id: 'class_archived', status: 'archived' })
    })

    const { req, res, next } = createMockContext({
      params: { id: 'e_sub_archived' }
    })

    await submitEssay(req, res, next)

    expect(next).toHaveBeenCalled()
    const err = next.mock.calls[0][0]
    expect(err.statusCode).toBe(400)
    expect(err.message).toBe('This class is archived and no longer accepting submissions.')
    expect(existingEssay.status).toBe('draft')
    expect(saveMock).not.toHaveBeenCalled()
  })

  it('UTCID06 (A) [LEARN-01]: should reject submitting assignment essay if student is not enrolled in class (403)', async () => {
    const existingEssay = {
      _id: 'e_sub_6',
      student: 'student_1',
      status: 'draft',
      content: Array(60).fill('word').join(' '),
      wordCount: 60,
      assignment: 'assign_ext',
      save: vi.fn(),
    }
    Essay.findById.mockResolvedValue(existingEssay)
    Assignment.findById.mockResolvedValue({
      _id: 'assign_ext',
      status: 'active',
      dueDate: new Date(Date.now() + 86400000),
      classId: 'class_ext',
    })
    Class.findById.mockResolvedValue({
      _id: 'class_ext',
      status: 'active',
      students: ['some_other_student'],
    })

    const { req, res, next } = createMockContext({
      params: { id: 'e_sub_6' },
      user: { _id: 'student_1', role: 'student' },
    })

    await submitEssay(req, res, next)

    expect(next).toHaveBeenCalled()
    const err = next.mock.calls[0][0]
    expect(err.statusCode).toBe(403)
  })

  it('UTCID07 (N) [LEARN-01]: should submit assignment essay when enrolled in active class and bind class', async () => {
    const saveMock = vi.fn().mockResolvedValue(true)
    const existingEssay = {
      _id: 'e_sub_7',
      student: 'student_1',
      status: 'draft',
      content: Array(60).fill('word').join(' '),
      wordCount: 60,
      assignment: 'assign_valid_7',
      save: saveMock,
    }
    Essay.findById.mockResolvedValue(existingEssay)
    Assignment.findById.mockResolvedValue({
      _id: 'assign_valid_7',
      status: 'active',
      dueDate: new Date(Date.now() + 86400000),
      classId: 'class_valid_7',
    })
    Class.findById.mockImplementation((id) => {
      const doc = {
        _id: id,
        status: 'active',
        students: ['student_1'],
        teacher: 'teacher_1',
      }
      return {
        ...doc,
        then: (fn) => Promise.resolve(doc).then(fn),
        select: vi.fn().mockResolvedValue({ teacher: 'teacher_1', name: 'IELTS A' }),
      }
    })

    const { req, res, next } = createMockContext({
      params: { id: 'e_sub_7' },
      user: { _id: 'student_1', role: 'student', name: 'An' },
    })

    await submitEssay(req, res, next)

    expect(res.status).toHaveBeenCalledWith(200)
    expect(existingEssay.status).toBe('submitted')
    expect(existingEssay.class).toBe('class_valid_7')
    expect(saveMock).toHaveBeenCalled()
    await vi.waitFor(() => expect(createNotification).toHaveBeenCalledWith(expect.objectContaining({
      recipient: 'teacher_1',
      sender: 'student_1',
      type: 'assignment',
      link: '/teacher/assignment/assign_valid_7',
    })))
  })

  it('does not notify any teacher for a free-writing essay without an assignment', async () => {
    const existingEssay = {
      _id: 'e_free', student: 'student_1', status: 'draft',
      content: Array(60).fill('word').join(' '), wordCount: 60, save: vi.fn().mockResolvedValue(true),
    }
    Essay.findById.mockResolvedValue(existingEssay)
    const { req, res, next } = createMockContext({ params: { id: 'e_free' }, user: { _id: 'student_1', role: 'student' } })

    await submitEssay(req, res, next)

    expect(res.status).toHaveBeenCalledWith(200)
    expect(createNotification).not.toHaveBeenCalled()
  })

  it('UTCID09 (A) [LEARN-23]: should reject submitEssay with 429 DAILY_ESSAY_LIMIT_REACHED when daily quota is exceeded', async () => {
    reserveDailyEssayQuota.mockResolvedValueOnce({
      reserved: false,
      tierInfo: { dailyAiEssayLimit: 3 },
    })

    const existingEssay = {
      _id: 'e_sub_quota_exceeded',
      student: 'student_1',
      status: 'draft',
      content: Array(60).fill('word').join(' '),
      wordCount: 60,
      save: vi.fn(),
    }
    Essay.findById.mockResolvedValue(existingEssay)

    const { req, res, next } = createMockContext({
      params: { id: 'e_sub_quota_exceeded' },
      user: { _id: 'student_1', role: 'student' },
    })

    await submitEssay(req, res, next)

    expect(next).toHaveBeenCalled()
    const err = next.mock.calls[0][0]
    expect(err.statusCode).toBe(429)
    expect(err.code).toBe('DAILY_ESSAY_LIMIT_REACHED')
    expect(err.message).toContain('Daily AI essay limit reached (3)')
    expect(err.limit).toBe(3)
    expect(err.tier).toBe('free')
    expect(existingEssay.status).toBe('draft')
    expect(existingEssay.save).not.toHaveBeenCalled()
  })

  it('UTCID10 (A) [LEARN-24]: should include tier-specific limit (e.g. 8 for Plus) when quota is exceeded', async () => {
    reserveDailyEssayQuota.mockResolvedValueOnce({
      reserved: false,
      tierInfo: { tier: 'plus', dailyAiEssayLimit: 8 },
    })

    const existingEssay = {
      _id: 'e_sub_plus_quota_exceeded',
      student: 'student_plus',
      status: 'draft',
      content: Array(60).fill('word').join(' '),
      wordCount: 60,
      save: vi.fn(),
    }
    Essay.findById.mockResolvedValue(existingEssay)

    const { req, res, next } = createMockContext({
      params: { id: 'e_sub_plus_quota_exceeded' },
      user: { _id: 'student_plus', role: 'student' },
    })

    await submitEssay(req, res, next)

    expect(next).toHaveBeenCalled()
    const err = next.mock.calls[0][0]
    expect(err.statusCode).toBe(429)
    expect(err.code).toBe('DAILY_ESSAY_LIMIT_REACHED')
    expect(err.message).toContain('Daily AI essay limit reached (8)')
    expect(err.limit).toBe(8)
    expect(err.tier).toBe('plus')
  })
})

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
import { updateEssay } from '../../src/controllers/essay.controller.js'

describe('F54: Edit Essay (updateEssay)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('UTCID01 (A) [LEARN-03]: should reject editing a reviewed essay (400)', async () => {
    const saveMock = vi.fn().mockResolvedValue(true)
    const existingEssay = {
      _id: 'essay_54_1',
      student: 'student_1',
      status: 'reviewed',
      title: 'Previous Title',
      save: saveMock
    }
    Essay.findById.mockResolvedValue(existingEssay)

    const { req, res, next } = createMockContext({
      params: { id: 'essay_54_1' },
      body: { title: 'Edited Title', content: 'Edited body paragraph' }
    })

    await updateEssay(req, res, next)

    expect(next).toHaveBeenCalled()
    const err = next.mock.calls[0][0]
    expect(err.statusCode).toBe(400)
    expect(err.message).toBe('Cannot edit a submitted or reviewed essay. Use revisions to make corrections.')
    expect(saveMock).not.toHaveBeenCalled()
  })

  it('UTCID01b (A) [LEARN-03]: should reject editing a submitted essay (400)', async () => {
    const saveMock = vi.fn().mockResolvedValue(true)
    const existingEssay = {
      _id: 'essay_54_submitted',
      student: 'student_1',
      status: 'submitted',
      title: 'Previous Title',
      save: saveMock
    }
    Essay.findById.mockResolvedValue(existingEssay)

    const { req, res, next } = createMockContext({
      params: { id: 'essay_54_submitted' },
      body: { title: 'Edited Title', content: 'Edited body paragraph' }
    })

    await updateEssay(req, res, next)

    expect(next).toHaveBeenCalled()
    const err = next.mock.calls[0][0]
    expect(err.statusCode).toBe(400)
    expect(err.message).toBe('Cannot edit a submitted or reviewed essay. Use revisions to make corrections.')
    expect(saveMock).not.toHaveBeenCalled()
  })

  it('UTCID01c (N): should edit draft essay and preserve draft status', async () => {
    const saveMock = vi.fn().mockResolvedValue(true)
    const existingEssay = {
      _id: 'essay_54_draft',
      student: 'student_1',
      status: 'draft',
      title: 'Previous Title',
      content: 'Original body',
      save: saveMock
    }
    Essay.findById.mockResolvedValue(existingEssay)

    const { req, res, next } = createMockContext({
      params: { id: 'essay_54_draft' },
      body: { title: 'Edited Title', content: 'Edited body paragraph' }
    })

    await updateEssay(req, res, next)

    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.data.success).toBe(true)
    expect(existingEssay.title).toBe('Edited Title')
    expect(existingEssay.content).toBe('Edited body paragraph')
    expect(existingEssay.status).toBe('draft')
    expect(saveMock).toHaveBeenCalled()
  })

  it('UTCID02 (N): should keep status as needs_revision when editing a revision-requested essay', async () => {
    const saveMock = vi.fn().mockResolvedValue(true)
    const existingEssay = {
      _id: 'essay_54_2',
      student: 'student_1',
      status: 'needs_revision',
      title: 'Revision Essay',
      save: saveMock
    }
    Essay.findById.mockResolvedValue(existingEssay)

    const { req, res, next } = createMockContext({
      params: { id: 'essay_54_2' },
      body: { content: 'Fixing teacher comments' }
    })

    await updateEssay(req, res, next)

    expect(res.status).toHaveBeenCalledWith(200)
    expect(existingEssay.status).toBe('needs_revision')
  })

  it('UTCID03 (A): should reject editing an essay owned by someone else (403)', async () => {
    const existingEssay = {
      _id: 'essay_54_3',
      student: 'different_user',
      status: 'draft'
    }
    Essay.findById.mockResolvedValue(existingEssay)

    const { req, res, next } = createMockContext({
      params: { id: 'essay_54_3' },
      body: { title: 'Tampering Title' }
    })

    await updateEssay(req, res, next)

    expect(next).toHaveBeenCalled()
    const err = next.mock.calls[0][0]
    expect(err.statusCode).toBe(403)
  })

  it('UTCID04 (B): should handle empty update body without crashing', async () => {
    const saveMock = vi.fn().mockResolvedValue(true)
    const existingEssay = {
      _id: 'essay_54_4',
      student: 'student_1',
      status: 'draft',
      title: 'Current Title',
      save: saveMock
    }
    Essay.findById.mockResolvedValue(existingEssay)

    const { req, res, next } = createMockContext({
      params: { id: 'essay_54_4' },
      body: {}
    })

    await updateEssay(req, res, next)

    expect(res.status).toHaveBeenCalledWith(200)
    expect(existingEssay.title).toBe('Current Title')
  })

  it('UTCID07 (N) [LEARN-22]: should strip HTML tags and store plain text in updateEssay', async () => {
    const saveMock = vi.fn().mockResolvedValue(true)
    const existingEssay = {
      _id: 'essay_54_plain',
      student: 'student_1',
      status: 'draft',
      content: 'old text',
      revisionCounter: 0,
      save: saveMock,
    }
    Essay.findById.mockResolvedValue(existingEssay)

    const { req, res, next } = createMockContext({
      user: { _id: 'student_1', role: 'student' },
      params: { id: 'essay_54_plain' },
      body: {
        content: '<div>Updated with <b>rich editor</b> formatting.</div><p>Paragraph 2</p>',
      },
    })

    await updateEssay(req, res, next)

    expect(res.status).toHaveBeenCalledWith(200)
    expect(existingEssay.content).not.toContain('<div>')
    expect(existingEssay.content).not.toContain('<b>')
    expect(existingEssay.content).toBe('Updated with rich editor formatting.\nParagraph 2')
  })
})

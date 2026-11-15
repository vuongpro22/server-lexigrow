import { vi, describe, it, expect, beforeEach } from 'vitest'
import { createMockContext } from './testHelper.js'

vi.mock('../../src/services/ai.service.js', () => ({
  runAIHelperService: vi.fn().mockImplementation(async (text, action) => {
    if (action === 'spellcheck') {
      return [{ error: 'he go', correction: 'he went', explanation: 'Grammar mistake' }]
    }
    return 'He went to school yesterday.'
  })
}))

import { runAIHelper } from '../../src/controllers/essay.controller.js'

describe('F58: Use AI Writing Assistant (runAIHelper)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('UTCID01 (N): should perform spellcheck action successfully', async () => {
    const { req, res, next } = createMockContext({
      body: { text: 'he go to school', action: 'spellcheck' }
    })

    await runAIHelper(req, res, next)

    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.data.success).toBe(true)
    expect(res.data.data[0].correction).toBe('he went')
  })

  it('UTCID02 (N): should perform improve action successfully', async () => {
    const { req, res, next } = createMockContext({
      body: { text: 'he go to school', action: 'improve' }
    })

    await runAIHelper(req, res, next)

    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.data.success).toBe(true)
    expect(typeof res.data.data).toBe('string')
  })

  it('UTCID03 (A): should return 400 when text is missing', async () => {
    const { req, res, next } = createMockContext({
      body: { action: 'spellcheck' }
    })

    await runAIHelper(req, res, next)

    expect(next).toHaveBeenCalled()
    const err = next.mock.calls[0][0]
    expect(err.statusCode).toBe(400)
    expect(err.message).toBe('Please provide text to process')
  })

  it('UTCID04 (A): should return 400 for invalid action type', async () => {
    const { req, res, next } = createMockContext({
      body: { text: 'Sample text', action: 'delete' }
    })

    await runAIHelper(req, res, next)

    expect(next).toHaveBeenCalled()
    const err = next.mock.calls[0][0]
    expect(err.statusCode).toBe(400)
    expect(err.message).toBe('Please provide a valid action (spellcheck or improve)')
  })
})

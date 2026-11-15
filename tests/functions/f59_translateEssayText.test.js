import { vi, describe, it, expect, beforeEach } from 'vitest'
import { createMockContext } from './testHelper.js'

vi.mock('../../src/services/ai.service.js', () => ({
  translateTextToVietnamese: vi.fn().mockImplementation((text) => {
    if (text === 'Hello world') return Promise.resolve('Xin chào thế giới')
    return Promise.resolve('Bản dịch mẫu nâng cao')
  })
}))

import { translateText } from '../../src/controllers/analysis.controller.js'

describe('F59: Translate Essay Text (translateText)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('UTCID01 (N): should translate text to Vietnamese successfully', async () => {
    const { req, res, next } = createMockContext({
      body: { text: 'Hello world' }
    })

    await translateText(req, res, next)

    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.data.success).toBe(true)
    expect(res.data.translation).toBe('Xin chào thế giới')
  })

  it('UTCID02 (N): should translate a long paragraph with punctuation', async () => {
    const { req, res, next } = createMockContext({
      body: { text: 'Artificial intelligence is reshaping education, linguistics, and cognitive development.' }
    })

    await translateText(req, res, next)

    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.data.success).toBe(true)
  })

  it('UTCID03 (B): should return 400 if text is empty string', async () => {
    const { req, res, next } = createMockContext({
      body: { text: '' }
    })

    await translateText(req, res, next)

    expect(next).toHaveBeenCalled()
    const err = next.mock.calls[0][0]
    expect(err.statusCode).toBe(400)
    expect(err.message).toBe('Please provide text to translate')
  })

  it('UTCID04 (A): should return 400 if text field is missing from body', async () => {
    const { req, res, next } = createMockContext({
      body: {}
    })

    await translateText(req, res, next)

    expect(next).toHaveBeenCalled()
    const err = next.mock.calls[0][0]
    expect(err.statusCode).toBe(400)
    expect(err.message).toBe('Please provide text to translate')
  })
})

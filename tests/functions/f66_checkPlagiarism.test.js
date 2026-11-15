import { vi, describe, it, expect, beforeEach } from 'vitest'

vi.mock('../../src/models/Essay.js', () => ({
  default: {
    find: vi.fn(),
  }
}))

import Essay from '../../src/models/Essay.js'
import { checkCrossStudentPlagiarism } from '../../src/services/plagiarism.service.js'

describe('F66: Check Plagiarism (checkCrossStudentPlagiarism)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('UTCID01 (N): should flag plagiarism when Jaccard 3-gram similarity is >= 0.25', async () => {
    const essayText = 'In this paper, I investigate the intricate tapestry of modern artificial intelligence and machine learning algorithms.'
    const matchedText = 'In this paper, I investigate the intricate tapestry of modern artificial intelligence and computer algorithms.'

    Essay.find.mockReturnValue({
      select: vi.fn().mockResolvedValue([
        { _id: 'prior_essay', title: 'Prior Essay', content: matchedText }
      ])
    })

    const result = await checkCrossStudentPlagiarism('target_essay', essayText)

    expect(result.isPlagiarized).toBe(true)
    expect(result.similarityScore).toBeGreaterThanOrEqual(0.25)
    expect(result.matchedEssay).toBe('prior_essay')
  })

  it('UTCID02 (N): should not flag plagiarism for completely unique content', async () => {
    const essayText = 'Quantum physics explores phenomena at microscopic subatomic scales which standard mechanics cannot explain.'
    const existingText = 'Cooking italian pizza requires high temperature brick ovens and fermented dough.'

    Essay.find.mockReturnValue({
      select: vi.fn().mockResolvedValue([
        { _id: 'pizza_essay', title: 'Pizza Recipe', content: existingText }
      ])
    })

    const result = await checkCrossStudentPlagiarism('quantum_essay', essayText)

    expect(result.isPlagiarized).toBe(false)
    expect(result.similarityScore).toBe(0)
    expect(result.matchedEssay).toBeNull()
  })

  it('UTCID03 (B): should return false and 0 similarity for short text with fewer than 5 tokens', async () => {
    const shortText = 'One two three'
    const result = await checkCrossStudentPlagiarism('short_essay', shortText)

    expect(result.isPlagiarized).toBe(false)
    expect(result.similarityScore).toBe(0)
    expect(result.matchedEssay).toBeNull()
  })

  it('UTCID04 (B): should not flag plagiarism if similarity is below 0.25 threshold', async () => {
    const essayText = 'The quick brown fox jumps over the lazy dog in the middle of summer.'
    const partialMatchText = 'The quick brown fox sleeps quietly in the middle of winter.'

    Essay.find.mockReturnValue({
      select: vi.fn().mockResolvedValue([
        { _id: 'fox_essay', title: 'Fox Story', content: partialMatchText }
      ])
    })

    const result = await checkCrossStudentPlagiarism('new_fox_essay', essayText)

    expect(result.isPlagiarized).toBe(false)
    expect(result.similarityScore).toBeLessThan(0.25)
  })

  it('UTCID05 (A): should handle empty string safely by returning false and 0 similarity', async () => {
    const result = await checkCrossStudentPlagiarism('empty_essay', '')

    expect(result.isPlagiarized).toBe(false)
    expect(result.similarityScore).toBe(0)
    expect(result.matchedEssay).toBeNull()
  })
})

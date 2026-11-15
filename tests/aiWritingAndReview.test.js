import { vi, describe, it, expect, beforeEach } from 'vitest'

vi.mock('../src/config/db.js', () => ({
  default: vi.fn().mockImplementation(() => Promise.resolve())
}))

vi.mock('../src/models/AILog.js', () => ({
  default: {
    create: vi.fn().mockResolvedValue(true)
  }
}))

vi.mock('../src/models/Config.js', () => ({
  default: {
    findOne: vi.fn().mockResolvedValue(null)
  }
}))

import { analyzeEssay, DEFAULT_ANALYSIS_PROMPT } from '../src/services/ai.service.js'
import AIAnalysis from '../src/models/AIAnalysis.js'

describe('Dev 3: AI Writing & Review Improvements', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('Prompt & Evidence Guidelines', () => {
    it('DEFAULT_ANALYSIS_PROMPT should require evidence quotes for suggestions', () => {
      expect(DEFAULT_ANALYSIS_PROMPT).toContain('"quote"')
      expect(DEFAULT_ANALYSIS_PROMPT).toContain('EVIDENCE REQUIREMENT')
    })

    it('DEFAULT_ANALYSIS_PROMPT should include target word evaluations schema', () => {
      expect(DEFAULT_ANALYSIS_PROMPT).toContain('"targetWordEvaluations"')
      expect(DEFAULT_ANALYSIS_PROMPT).toContain('"contextQuote"')
      expect(DEFAULT_ANALYSIS_PROMPT).toContain('TARGET WORDS')
    })

    it('DEFAULT_ANALYSIS_PROMPT should include suggestedRevision and preserve meaning and language level', () => {
      expect(DEFAULT_ANALYSIS_PROMPT).toContain('"suggestedRevision"')
      expect(DEFAULT_ANALYSIS_PROMPT).toContain("Preserve the student's intended meaning")
    })
  })

  describe('Fallback Mode & Target Vocabulary Evaluation', () => {
    it('should generate fallback analysis with isFallback: true, quote evidence, and target word evaluations when AI is unavailable', async () => {
      const sampleEssay = 'In modern life, an efficient daily routine helps people succeed. To achieve goals, we must organize our time and commute wisely.'
      const targetWordsInfo = {
        targetWords: ['routine', 'commute', 'efficient'],
        weakWords: ['succeed']
      }

      // analyzeEssay will fall back to local heuristics when GROQ_API_KEY is not configured or fails
      const analysis = await analyzeEssay(sampleEssay, null, '', targetWordsInfo)

      expect(analysis).toBeDefined()
      expect(analysis.isFallback).toBe(true)
      // Fallback heuristics must not present a fabricated rubric score.
      expect(analysis.overallScore).toBeNull()
      expect(analysis.scoringMethod).toBe('fallback_unavailable')
      expect(analysis.scores).toBeDefined()

      // Verify target word evaluations
      expect(analysis.targetWordEvaluations).toBeDefined()
      expect(analysis.targetWordEvaluations.length).toBe(3)
      
      const routineEval = analysis.targetWordEvaluations.find(w => w.word === 'routine')
      expect(routineEval).toBeDefined()
      expect(routineEval.found).toBe(true)
      expect(routineEval.status).toBe('needs_improvement')
      expect(routineEval.feedback).toContain('cannot verify')
      expect(routineEval.contextQuote).toContain('routine')

      // Verify evidence quotes in suggestions
      expect(analysis.suggestions).toBeDefined()
      expect(analysis.suggestions.length).toBeGreaterThan(0)
      for (const suggestion of analysis.suggestions) {
        expect(suggestion.text).toBeDefined()
        expect(suggestion).toHaveProperty('quote')
        if (suggestion.type === 'improvement') {
          expect(typeof suggestion.quote).toBe('string')
        }
      }
    })
  })

  describe('AIAnalysis Schema', () => {
    it('schema definition should include isFallback, targetWordEvaluations, and new LexiYoung fields', () => {
      const paths = AIAnalysis.schema.paths
      expect(paths).toHaveProperty('isFallback')
      expect(paths).toHaveProperty('targetWordEvaluations')
      const suggestionPaths = paths.suggestions?.schema?.paths || paths
      expect(suggestionPaths).toHaveProperty('suggestedRevision')
      expect(suggestionPaths).toHaveProperty('quoteStart')
      expect(suggestionPaths).toHaveProperty('quoteEnd')
      expect(paths).toHaveProperty('contentHash')
      expect(paths).toHaveProperty('contentRevision')
    })
  })

  describe('Character Limit Guard', () => {
    it('should throw an error if essay exceeds 30,000 characters', async () => {
      const { processEssayAnalysis } = await import('../src/services/ai.service.js')
      const hugeContent = 'a'.repeat(30001)
      await expect(
        processEssayAnalysis('fake_id', 'fake_student', hugeContent, null)
      ).rejects.toThrow('Essay content exceeds maximum limit of 30,000 characters.')
    })
  })
})

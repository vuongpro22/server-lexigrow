/**
 * AI Grading Contract & Verification Tests.
 *
 * Verifies that:
 * - findQuoteInEssay handles exact and whitespace/punctuation variations.
 * - revisionOverlap accurately detects relevance and rejects unrelated rewrites.
 * - negationCount detects meaning reversal.
 * - verifySuggestionEvidence drops fabricated quotes and keeps verified ones.
 * - validateParsedAnalysis enforces contract shapes.
 * - aggregateOverallScore computes deterministic arithmetic mean across sub-scores.
 * - scoreToCefr and scoreToIeltsBand map consistently.
 */
import { describe, expect, it } from 'vitest'
import {
  findQuoteInEssay,
  revisionOverlap,
  negationCount,
  aggregateOverallScore,
  scoreToCefr,
  scoreToIeltsBand,
  calculateCefrDistribution,
  RUBRIC_VERSION,
  validateParsedAnalysis,
  verifySuggestionEvidence,
  verifyTargetWordEvidence,
} from '../src/services/ai.service.js'

const essay = [
  'In todays modern world, technology has changed the way students learn.',
  'Online platforms allow learners to study whenever they want to.',
  'However, many teachers believe that face-to-face classes are still better.',
].join('\n\n')

const validAnalysis = (overrides = {}) => ({
  overallScore: 7.5,
  scores: {
    vocabularyDiversity: 0.6,
    lexicalResource: 7.0,
    grammarAccuracy: 7.0,
    coherence: 7.0,
    complexityIndex: 6.0,
    promptAdherence: 7.0,
  },
  suggestions: [
    {
      type: 'improvement',
      text: 'Vary sentence openings.',
      quote: 'Online platforms allow learners to study whenever they want to.',
      suggestedRevision: 'Online learning platforms let learners study whenever they wish.',
    },
  ],
  writingStats: { avgSentenceLength: 12, uniqueWords: 40 },
  learningPatterns: {
    paddedSentences: false,
    plagiarismDetected: false,
    learningStatus: 'plateau',
    feedback: 'Consistent intermediate performance.',
  },
  ...overrides,
})

describe('findQuoteInEssay', () => {
  it('accepts an exact quote', () => {
    const result = findQuoteInEssay(essay, 'technology has changed the way students learn.')
    expect(result).not.toBeNull()
    expect(essay.slice(result.index, result.index + result.length)).toContain('technology')
  })

  it('tolerates whitespace/typography drift from model quoting style', () => {
    const result = findQuoteInEssay(essay, 'technology has changed  the way\nstudents learn')
    expect(result).not.toBeNull()
  })

  it('rejects fabricated quotes', () => {
    expect(findQuoteInEssay(essay, 'This quote was invented by the model and never written.')).toBeNull()
  })
})

describe('revisionOverlap and negationCount', () => {
  it('accepts a rewrite of the same sentence', () => {
    const q = 'Online platforms allow learners to study whenever they want to.'
    const r = 'Online learning platforms let students study whenever they wish.'
    expect(revisionOverlap(q, r)).toBeGreaterThan(0.25)
  })

  it('rejects an unrelated sentence', () => {
    const q = 'Online platforms allow learners to study whenever they want to.'
    const r = 'My grandmother grew tomatoes in her garden every summer morning.'
    expect(revisionOverlap(q, r)).toBeLessThan(0.25)
  })

  it('detects negation mismatch', () => {
    const q = 'Online platforms allow learners to study whenever they want to.'
    const r = 'Online platforms never allow learners to study whenever they want to.'
    expect(negationCount(q)).toBe(0)
    expect(negationCount(r)).toBe(1)
  })
})

describe('verifySuggestionEvidence', () => {
  it('drops suggestions whose quote was fabricated but keeps verified ones', () => {
    const { suggestions, dropped } = verifySuggestionEvidence(
      [
        {
          type: 'improvement',
          text: 'Fake claim about a sentence that does not exist.',
          quote: 'The model hallucinated this entire sentence about quantum physics.',
          suggestedRevision: 'Another invented rewrite.',
        },
        validAnalysis().suggestions[0],
      ],
      essay,
    )
    expect(dropped).toBe(1)
    expect(suggestions).toHaveLength(1)
    expect(suggestions[0].quoteStart).toBeGreaterThan(-1)
  })

  it('drops a suggestedRevision that is not derived from the quoted sentence', () => {
    const { dropped } = verifySuggestionEvidence(
      [
        {
          type: 'improvement',
          text: 'Improve this sentence.',
          quote: 'However, many teachers believe that face-to-face classes are still better.',
          suggestedRevision: 'The weather in Paris is lovely during the spring season here.',
        },
      ],
      essay,
    )
    expect(dropped).toBe(1)
  })

  it('drops empty quotes or single short words', () => {
    const { suggestions, dropped } = verifySuggestionEvidence(
      [
        { type: 'strength', text: 'Nice', quote: 'the', suggestedRevision: '' },
        { type: 'strength', text: 'Good', quote: '', suggestedRevision: '' },
      ],
      essay,
    )
    expect(dropped).toBe(2)
    expect(suggestions).toHaveLength(0)
  })
})

describe('verifyTargetWordEvidence', () => {
  it('requires an authentic quote that contains the evaluated target word', () => {
    const checked = verifyTargetWordEvidence([
      { word: 'routine', status: 'correct', found: true, contextQuote: 'A routine helps me study.' },
      { word: 'routine', status: 'correct', found: true, contextQuote: 'A schedule helps me study.' },
      { word: 'routine', status: 'correct', found: true, contextQuote: 'Invented routine quote.' },
    ], 'A routine helps me study.')
    expect(checked[0]).toMatchObject({ status: 'correct', quoteVerified: true })
    expect(checked[1]).toMatchObject({ status: 'not_used', found: false, quoteVerified: false })
    expect(checked[2]).toMatchObject({ status: 'not_used', found: false, quoteVerified: false })
  })

  it('does not label a genuine unrelated quote as target-word evidence', () => {
    const checked = verifyTargetWordEvidence([
      { word: 'routine', status: 'correct', found: true, contextQuote: 'A schedule helps me study.' },
    ], 'A schedule helps me study.')
    expect(checked[0]).toMatchObject({ status: 'not_used', found: false, quoteVerified: false })
  })

  it('accepts punctuation boundaries and inflections while rejecting words cited only inside quotation marks', () => {
    const essay = 'I maintain a healthy routine. She studied every evening. The teacher explained "routine" in class.'
    const checked = verifyTargetWordEvidence([
      { word: 'routine', status: 'correct', found: true, contextQuote: 'I maintain a healthy routine.' },
      { word: 'study', status: 'correct', found: true, contextQuote: 'She studied every evening.' },
      { word: 'routine', status: 'correct', found: true, contextQuote: 'The teacher explained "routine" in class.' },
    ], essay)
    expect(checked[0]).toMatchObject({ status: 'correct', quoteVerified: true })
    expect(checked[1]).toMatchObject({ status: 'correct', quoteVerified: true })
    expect(checked[2]).toMatchObject({ status: 'not_used', found: false, quoteVerified: false })
  })
})

describe('validateParsedAnalysis', () => {
  it('accepts a well-formed grading result', () => {
    expect(() => validateParsedAnalysis(validAnalysis())).not.toThrow()
  })

  it('rejects an incoherent result: overall 10 with all criteria 0', () => {
    expect(() =>
      validateParsedAnalysis(validAnalysis({ overallScore: 10, scores: { vocabularyDiversity: 0.8, grammarAccuracy: 0, coherence: 0, complexityIndex: 0 } })),
    ).toThrow(/contract/)
    expect(() =>
      validateParsedAnalysis(validAnalysis({
        overallScore: 10,
        scores: {
          vocabularyDiversity: 0.8,
          lexicalResource: 1,
          grammarAccuracy: 0,
          coherence: 0,
          complexityIndex: 0,
          promptAdherence: 1,
        },
      })),
    ).toThrow(/incoherent/)
    expect(() =>
      validateParsedAnalysis(validAnalysis({
        overallScore: 10,
        scores: {
          vocabularyDiversity: 0.8,
          lexicalResource: 8,
          grammarAccuracy: 0,
          coherence: 0,
          complexityIndex: 0,
          promptAdherence: 0,
        },
      })),
    ).not.toThrow()
  })

  it('rejects results that are missing required criteria', () => {
    const broken = validAnalysis()
    delete broken.scores.grammarAccuracy
    expect(() => validateParsedAnalysis(broken)).toThrow(/contract/)
  })

  it('requires every fixed rubric score with or without assignment context', () => {
    expect(() => validateParsedAnalysis(validAnalysis({ scores: { ...validAnalysis().scores, promptAdherence: undefined } }), { hasPromptContext: true })).toThrow(/scores.promptAdherence/)
    expect(() => validateParsedAnalysis(validAnalysis(), { hasPromptContext: true })).not.toThrow()
    expect(() => validateParsedAnalysis(validAnalysis(), { hasPromptContext: false })).not.toThrow()
  })

  it('keeps vocabulary diversity inside the TTR range', () => {
    const broken = validAnalysis()
    broken.scores.vocabularyDiversity = 1.1
    expect(() => validateParsedAnalysis(broken)).toThrow(/scores.vocabularyDiversity must be a number in 0–1/)
  })
})

describe('CEFR distribution', () => {
  it('does not double count AWL words already classified as advanced CEFR', async () => {
    const result = await calculateCefrDistribution('alpha beta gamma', [
      { word: 'alpha', cefr: 'B2', awl: true },
      { word: 'beta', cefr: 'C1', awl: false },
      { word: 'gamma', cefr: 'A1', awl: false },
    ])
    expect(result.b2).toBeCloseTo(33.3)
    expect(result.c1).toBeCloseTo(33.3)
    expect(result.awl).toBe(0)
    expect(result.advancedPercentage).toBeCloseTo(66.7)
    expect(result.matchedWords).toBe(3)
    expect(result.coverage).toBe(100)
    expect(result.a1 + result.a2 + result.b1 + result.b2 + result.c1 + result.c2 + result.awl).toBeLessThanOrEqual(100)

    const awlOnly = await calculateCefrDistribution('alpha beta gamma', [
      { word: 'alpha', cefr: 'B2', awl: true },
      { word: 'beta', cefr: '', awl: true },
      { word: 'gamma', cefr: 'A1', awl: false },
    ])
    expect(awlOnly.b2).toBeCloseTo(33.3)
    expect(awlOnly.awl).toBeCloseTo(33.3)
    expect(awlOnly.a1 + awlOnly.awl + awlOnly.b2).toBeCloseTo(99.9)
    expect(awlOnly.a1 + awlOnly.awl + awlOnly.b2).toBeLessThanOrEqual(100)
  })
})

describe('CEFR distribution coverage', () => {
  it('reports how many essay words the CEFR list matched', async () => {
    const result = await calculateCefrDistribution('the people think technology changes school life', [
      { word: 'school', cefr: 'A1', awl: false },
      { word: 'technology', cefr: 'B1', awl: false },
    ])
    expect(result.uniqueWords).toBe(7)
    expect(result.matchedWords).toBe(2)
    expect(result.coverage).toBeCloseTo(28.6)
  })
})

describe('aggregateOverallScore and standard mappings', () => {
  it('uses a fixed set of five 0-10 rubric criteria', () => {
    const base = { grammarAccuracy: 7, coherence: 7, complexityIndex: 6, lexicalResource: 8, promptAdherence: 9 }
    expect(aggregateOverallScore(base)).toBe(7.4)
    expect(aggregateOverallScore({ ...base, optionalModelField: 10 })).toBe(7.4)
    expect(aggregateOverallScore({ grammarAccuracy: 7, coherence: 7, complexityIndex: 6 })).toBeNull()
    expect(aggregateOverallScore({ grammarAccuracy: 10, coherence: 10, complexityIndex: 10, lexicalResource: 10, promptAdherence: 10 })).toBe(10)
    expect(aggregateOverallScore({ grammarAccuracy: 0, coherence: 0, complexityIndex: 0, lexicalResource: 0, promptAdherence: 0 })).toBe(0)
  })

  it('does not fabricate CEFR or IELTS grades for missing scores', () => {
    expect(scoreToCefr(null)).toBeNull()
    expect(scoreToCefr(Number.NaN)).toBeNull()
    expect(scoreToIeltsBand(null)).toBeNull()
    expect(scoreToIeltsBand(Number.NaN)).toBeNull()
  })

  it('maps scores to CEFR levels and IELTS Bands correctly', () => {
    expect(scoreToCefr(9.5)).toBe('C2')
    expect(scoreToCefr(8.0)).toBe('C1')
    expect(scoreToCefr(6.5)).toBe('B2')
    expect(scoreToCefr(5.0)).toBe('B1')
    expect(scoreToCefr(3.5)).toBe('A2')
    expect(scoreToCefr(2.0)).toBe('A1')

    expect(scoreToIeltsBand(9.5)).toBe(9.0)
    expect(scoreToIeltsBand(8.0)).toBe(8.0)
    expect(scoreToIeltsBand(6.5)).toBe(6.5)
    expect(scoreToIeltsBand(5.0)).toBe(5.0)
  })

  it('verifies rubric version constant', () => {
    expect(RUBRIC_VERSION).toBe('rubric-v2-fixed-criteria')
  })
})

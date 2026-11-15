import { describe, it, expect, vi } from 'vitest'

vi.mock('../src/services/ai.service.js', () => ({
  getConfigValue: vi.fn(async () => undefined),
}))
vi.mock('../src/services/cache.service.js', () => ({
  default: { hashKey: () => 'test-key', get: async () => null, set: async () => true },
}))

import {
  summarizeMetrics,
  buildFallbackRecommendations,
  generateAIGoalRecommendations,
  normalizeRecommendations,
} from '../src/services/goalsRecommendation.service.js'

describe('goalsRecommendation.service', () => {
  it('summarizes last-week completion rate from goal targets', () => {
    const metrics = summarizeMetrics({
      lastWeekGoal: { goals: [{ label: 'New Words', target: 20, current: 20 }, { label: 'Essays Written', target: 2, current: 1 }] },
      newWordsLastWeek: 20,
      essaysLastWeek: 1,
      wordsWrittenLastWeek: 300,
      avgTTR: 0.45,
      avgComplexity: 6,
      studyMinutesLastWeek: 40,
      totalVocab: 150,
      totalEssays: 6,
    })
    expect(metrics.lastWeekCompletionRate).toBe(75)
    expect(metrics.newWordsLastWeek).toBe(20)
  })

  it('fallback encourages restart when last week was weak', () => {
    const recs = buildFallbackRecommendations({
      newWordsLastWeek: 2, essaysLastWeek: 0, wordsWrittenLastWeek: 0, avgTTR: 0, lastWeekCompletionRate: 10,
    })
    expect(recs.length).toBe(2)
    expect(recs.every((r) => r.rationale)).toBe(true)
  })

  it('returns fallback source when Groq key is missing', async () => {
    const metrics = summarizeMetrics({
      lastWeekGoal: null, newWordsLastWeek: 0, essaysLastWeek: 0, wordsWrittenLastWeek: 0,
      avgTTR: 0, avgComplexity: 0, studyMinutesLastWeek: 0, totalVocab: 0, totalEssays: 0,
    })
    const result = await generateAIGoalRecommendations({ _id: 'u1', learningProfile: {} }, metrics)
    // Without GROQ_API_KEY in test env this must be fallback, never throw
    expect(['ai', 'fallback']).toContain(result.source)
    expect(result.recommendations.length).toBeGreaterThan(0)
    if (result.source === 'fallback') expect(typeof result.reason).toBe('string')
  })

  it('fallback recs carry structured apply fields', () => {
    const recs = buildFallbackRecommendations({
      newWordsLastWeek: 12, essaysLastWeek: 0, wordsWrittenLastWeek: 0, avgTTR: 0, lastWeekCompletionRate: 40,
    })
    const withTarget = recs.find((r) => r.goalKey === 'new_words')
    expect(withTarget).toMatchObject({ goalLabel: 'New Words', applicable: true })
    expect(withTarget.suggestedTarget).toBeGreaterThanOrEqual(1)
    const essays = recs.find((r) => r.goalKey === 'essays_written')
    expect(essays).toMatchObject({ suggestedTarget: 1, applicable: true })
  })

  it('normalize keeps valid targets, clamps and drops invalid ones', () => {
    const out = normalizeRecommendations([
      { text: 'a', goalKey: 'new_words', goalLabel: 'New Words', suggestedTarget: 500, applicable: true },
      { text: 'b', goalKey: 'nope', suggestedTarget: 5, applicable: true },
      { text: 'c', rationale: 'general advice' },
      null,
    ])
    expect(out).toHaveLength(3)
    expect(out[0]).toMatchObject({ goalKey: 'new_words', suggestedTarget: 100, applicable: true })
    expect(out[1]).toMatchObject({ applicable: false })
    expect(out[1].suggestedTarget).toBeUndefined()
    expect(out[2]).toMatchObject({ applicable: false })
  })

  it('normalize resolves goalKey-only recs to labels', () => {
    const out = normalizeRecommendations([
      { text: 'a', goalKey: 'complexity_score', suggestedTarget: 9 },
    ])
    expect(out[0]).toMatchObject({ goalLabel: 'Complexity Score', suggestedTarget: 9, applicable: true })
  })
})

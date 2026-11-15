import { describe, expect, it } from 'vitest'
import { selectTopicRound } from '../src/services/topicRound.service.js'
const set = { _id: 'set-1', slug: 'daily-life', items: ['routine', 'commute', 'grocery'].map(word => ({ word, definitionVi: word })) }
const completed = words => ({ mode: 'static', learningSetSlug: set.slug, status: 'completed', targetWords: words })
describe('topic round vocabulary', () => {
  it('keeps the original first round and supplies fresh words after completion', () => {
    const first = selectTopicRound(set)
    expect(first.targetWords.map(w => w.word)).toEqual(['routine', 'commute', 'grocery'])
    const second = selectTopicRound(set, [completed(first.targetWords)])
    expect(second.targetWords.map(w => w.word)).toEqual(['schedule', 'errand', 'household'])
    expect(second.round).toBe(2)
    expect(second.isReview).toBe(false)
  })
  it('does not advance for an abandoned session or consume another topic', () => {
    expect(selectTopicRound(set, [{ ...completed(set.items), status: 'abandoned' }, { ...completed(set.items), learningSetSlug: 'travel' }]).targetWords.map(w => w.word))
      .toEqual(['routine', 'commute', 'grocery'])
  })
  it('preserves active target snapshots when resuming', () => {
    const active = { ...completed([{ word: 'schedule' }]), status: 'in_progress' }
    expect(selectTopicRound(set, [completed(set.items), active]).targetWords).toEqual(active.targetWords)
  })
  it('marks review only after the topic pool is exhausted', () => {
    const history = []
    for (let i = 0; i < 4; i++) {
      const next = selectTopicRound(set, history)
      expect(next.isReview).toBe(false)
      history.push(completed(next.targetWords))
    }
    expect(new Set(history.flatMap(s => s.targetWords.map(w => w.word))).size).toBe(12)
    expect(selectTopicRound(set, history).isReview).toBe(true)
  })
})

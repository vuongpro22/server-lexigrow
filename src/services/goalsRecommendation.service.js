import { getConfigValue } from './ai.service.js'
import cacheService from './cache.service.js'
import { completeThroughRelay } from './aiRelayClient.service.js'
import { GOAL_KEYS, clampGoalTarget } from '../utils/validateGoals.js'

export const APPLICABLE_GOAL_KEYS = new Set(Object.values(GOAL_KEYS))

/**
 * Normalize one recommendation into the structured shape the FE 1-click
 * apply button needs. Invalid/missing target info degrades gracefully to
 * a display-only rec (applicable: false) instead of being dropped.
 */
export function normalizeRecommendation(rec) {
  if (!rec || typeof rec !== 'object') return null
  const base = {
    icon: typeof rec.icon === 'string' ? rec.icon : 'star',
    color: typeof rec.color === 'string' ? rec.color : 'primary',
    text: typeof rec.text === 'string' ? rec.text : '',
    rationale: typeof rec.rationale === 'string' ? rec.rationale : '',
  }
  const goalLabel = typeof rec.goalLabel === 'string' ? rec.goalLabel : null
  const key = typeof rec.goalKey === 'string' ? rec.goalKey : null
  let label = null
  if (goalLabel && GOAL_KEYS[goalLabel]) {
    label = goalLabel
  } else if (key) {
    const found = Object.entries(GOAL_KEYS).find(([, k]) => k === key)
    if (found) label = found[0]
  }
  const clamped = label ? clampGoalTarget(label, rec.suggestedTarget) : null
  if (label && clamped !== null && rec.applicable !== false) {
    return { ...base, goalKey: GOAL_KEYS[label], goalLabel: label, suggestedTarget: clamped, applicable: true }
  }
  return { ...base, applicable: false }
}

export function normalizeRecommendations(list) {
  if (!Array.isArray(list)) return []
  return list.map(normalizeRecommendation).filter(Boolean).slice(0, 3)
}

/**
 * Collect real learning metrics for a given week range.
 * Pure data gathering — no AI call here so it is unit-testable.
 */
export function summarizeMetrics({
  lastWeekGoal,
  newWordsLastWeek,
  essaysLastWeek,
  wordsWrittenLastWeek,
  avgTTR,
  avgComplexity,
  studyMinutesLastWeek,
  totalVocab,
  totalEssays,
}) {
  const goals = lastWeekGoal?.goals || []
  const completionRate = goals.length > 0
    ? Math.round(
      goals.reduce((sum, g) => sum + Math.min(1, g.target > 0 ? (g.current || 0) / g.target : 0), 0)
        / goals.length * 100,
    )
    : 0
  return {
    newWordsLastWeek,
    essaysLastWeek,
    wordsWrittenLastWeek,
    avgTTR,
    avgComplexity,
    studyMinutesLastWeek,
    totalVocab,
    totalEssays,
    lastWeekCompletionRate: completionRate,
    lastWeekGoals: goals.map((g) => ({ label: g.label, target: g.target, current: g.current || 0 })),
  }
}

/**
 * Rule-based fallback — improved vs old if-else on lifetime totals.
 * Decisions are driven by LAST WEEK metrics + completion rate.
 */
export function buildFallbackRecommendations(metrics) {
  const recs = []
  const {
    newWordsLastWeek = 0,
    essaysLastWeek = 0,
    wordsWrittenLastWeek = 0,
    avgTTR = 0,
    lastWeekCompletionRate = 0,
  } = metrics

  if (lastWeekCompletionRate >= 100) {
    const suggestedTarget = Math.min(50, Math.max(10, newWordsLastWeek + 5))
    recs.push({
      icon: 'trending_up',
      color: 'primary',
      text: `Great week! You hit ${lastWeekCompletionRate}% of last week's goals. Raise New Words target to ${suggestedTarget}.`,
      rationale: `Based on last week: ${newWordsLastWeek} new words with ${lastWeekCompletionRate}% completion.`,
      goalKey: 'new_words',
      goalLabel: 'New Words',
      suggestedTarget,
      applicable: true,
    })
  } else if (lastWeekCompletionRate >= 60) {
    const suggestedTarget = Math.max(5, newWordsLastWeek)
    recs.push({
      icon: 'trending_up',
      color: 'primary',
      text: `Solid progress at ${lastWeekCompletionRate}%. Keep New Words around ${suggestedTarget} to stay consistent.`,
      rationale: `Based on last week: ${newWordsLastWeek} words, ${essaysLastWeek} essays, ${lastWeekCompletionRate}% completion.`,
      goalKey: 'new_words',
      goalLabel: 'New Words',
      suggestedTarget,
      applicable: true,
    })
  } else {
    const suggestedTarget = Math.max(5, Math.ceil(newWordsLastWeek / 2) || 10)
    recs.push({
      icon: 'restart_alt',
      color: 'primary',
      text: `Last week reached ${lastWeekCompletionRate}%. Lower the bar slightly — aim for ${suggestedTarget} new words to rebuild momentum.`,
      rationale: `Based on last week: only ${newWordsLastWeek} words / ${essaysLastWeek} essays, completion ${lastWeekCompletionRate}%.`,
      goalKey: 'new_words',
      goalLabel: 'New Words',
      suggestedTarget,
      applicable: true,
    })
  }

  if (essaysLastWeek === 0) {
    recs.push({
      icon: 'edit_note',
      color: 'secondary',
      text: 'You wrote no essays last week. Aim for 1 short essay to restart the writing habit.',
      rationale: `Based on last week: 0 essays submitted, ${wordsWrittenLastWeek} words written.`,
      goalKey: 'essays_written',
      goalLabel: 'Essays Written',
      suggestedTarget: 1,
      applicable: true,
    })
  } else if (avgTTR > 0 && avgTTR < 0.5) {
    recs.push({
      icon: 'category',
      color: 'tertiary',
      text: 'Your vocabulary diversity (TTR) is low. Focus on academic vocabulary and synonyms this week.',
      rationale: `Based on last week: avg TTR ${avgTTR.toFixed(2)} across essays.`,
      applicable: false,
    })
  } else {
    recs.push({
      icon: 'schedule',
      color: 'secondary',
      text: 'Try writing on a new topic this week to diversify vocabulary.',
      rationale: `Based on last week: ${essaysLastWeek} essays, ${wordsWrittenLastWeek} words.`,
      applicable: false,
    })
  }

  return normalizeRecommendations(recs)
}

/**
 * AI-powered weekly goal recommendations grounded in last-week metrics.
 * Returns { recommendations, source, reason } — never throws.
 */
export async function generateAIGoalRecommendations(student, metrics) {
  const cacheKey = cacheService.hashKey('ai_rec:weekly_goals', {
    student: String(student._id || student),
    w: metrics.newWordsLastWeek,
    e: metrics.essaysLastWeek,
    t: metrics.avgTTR,
    c: metrics.lastWeekCompletionRate,
  })
  try {
    const cached = await cacheService.get(cacheKey)
    if (cached?.recommendations?.length > 0) {
      const recommendations = normalizeRecommendations(cached.recommendations)
      if (recommendations.length > 0) {
        return { recommendations, source: 'ai', reason: null, cached: true }
      }
    }
  } catch {
    // cache miss — continue to AI
  }

  try {
    const activeModel = await getConfigValue('DEFAULT_AI_MODEL', 'llama-3.3-70b-versatile')
    const level = student.learningProfile?.targetLevel || 'B1'

    const prompt = `You are an English learning coach for LexiGrow. Suggest 2-3 weekly goals from LAST WEEK real data.

Student level: ${level}
Last week metrics (JSON): ${JSON.stringify(metrics)}

Return ONLY valid JSON:
{
  "recommendations": [
    {"icon": "trending_up|edit_note|category|schedule", "color": "primary|secondary|tertiary",
     "text": "concrete suggestion with numbers",
     "rationale": "which metric justifies this (e.g. last week 12 words, 60% completion)",
     "goalKey": "new_words|essays_written|writing_length|complexity_score",
     "goalLabel": "New Words|Essays Written|Writing Length (words)|Complexity Score",
     "suggestedTarget": 25,
     "applicable": true}
  ]
}
Rules: base every suggestion on the metrics above, keep targets realistic, no markdown.
When a suggestion maps to a weekly goal, include goalKey, goalLabel, suggestedTarget and applicable true.
When it is general advice with no concrete target, set applicable false and omit the target fields.`

    const completion = await completeThroughRelay({
      route: 'goal_recommendation',
      messages: [
        { role: 'system', content: 'You are a learning coach. Return only valid JSON.' },
        { role: 'user', content: prompt },
      ],
      model: activeModel,
      responseFormat: { type: 'json_object' },
      timeoutMs: 8000,
    })
    let jsonStr = completion.text.trim()
    const m = completion.text.match(/```(?:json)?\s*([\s\S]*?)```/)
    if (m) jsonStr = m[1].trim()
    const parsed = JSON.parse(jsonStr)
    const recommendations = normalizeRecommendations(parsed.recommendations)
    if (recommendations.length === 0) throw new Error('AI returned empty recommendations')

    const payload = { recommendations, source: 'ai', reason: null }
    try {
      await cacheService.set(cacheKey, payload, 3600)
    } catch {
      // ignore cache write errors
    }
    return payload
  } catch (err) {
    const recommendations = buildFallbackRecommendations(metrics)
    return { recommendations, source: 'fallback', reason: err.message }
  }
}

export default { summarizeMetrics, buildFallbackRecommendations, generateAIGoalRecommendations, normalizeRecommendation, normalizeRecommendations }

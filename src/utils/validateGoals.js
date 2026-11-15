import ErrorResponse from './ErrorResponse.js'

export const ALLOWED_GOAL_LABELS = [
  'New Words',
  'Essays Written',
  'Writing Length (words)',
  'Complexity Score',
]

export const GOAL_KEYS = {
  'New Words': 'new_words',
  'Essays Written': 'essays_written',
  'Writing Length (words)': 'writing_length',
  'Complexity Score': 'complexity_score',
}

export const GOAL_KEY_BY_KEY = Object.fromEntries(
  Object.entries(GOAL_KEYS).map(([label, key]) => [key, label]),
)

// Matches the slider bounds in SetWeeklyGoals.jsx
export const GOAL_BOUNDS = {
  'New Words': { min: 1, max: 100 },
  'Essays Written': { min: 1, max: 100 },
  'Writing Length (words)': { min: 1000, max: 100000 },
  'Complexity Score': { min: 1, max: 10 },
}

export const MAX_GOALS = 4
export const MAX_LABEL_LEN = 60
const ALLOWED_ICONS = ['dictionary', 'edit_note', 'text_fields', 'equalizer', 'flag', 'star']
const ALLOWED_COLORS = ['primary', 'secondary', 'tertiary']

export function clampGoalTarget(label, value) {
  const bounds = GOAL_BOUNDS[label]
  if (!bounds || typeof value !== 'number' || !Number.isFinite(value)) return null
  return Math.min(bounds.max, Math.max(bounds.min, Math.round(value)))
}

/**
 * Validate + sanitize a weekly-goals array from the client.
 * Returns a sanitized copy (client-sent `current` is always dropped —
 * progress is recomputed server-side on GET).
 * Throws ErrorResponse(400) on the first problem found.
 */
export function validateGoalsArray(goals) {
  if (!Array.isArray(goals)) throw new ErrorResponse('Goals must be an array', 400)
  if (goals.length === 0) throw new ErrorResponse('Goals array must not be empty', 400)
  if (goals.length > MAX_GOALS) {
    throw new ErrorResponse(`Goals array must not exceed ${MAX_GOALS} items`, 400)
  }
  const seen = new Set()
  return goals.map((item, i) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new ErrorResponse(`goals[${i}] must be an object`, 400)
    }
    const label = typeof item.label === 'string' ? item.label.trim() : ''
    if (!label || label.length > MAX_LABEL_LEN) {
      throw new ErrorResponse(`goals[${i}].label must be 1-${MAX_LABEL_LEN} characters`, 400)
    }
    if (!ALLOWED_GOAL_LABELS.includes(label)) {
      throw new ErrorResponse(`goals[${i}].label '${label}' is not allowed`, 400)
    }
    if (seen.has(label)) throw new ErrorResponse(`Duplicate goal label '${label}'`, 400)
    seen.add(label)
    if (typeof item.target !== 'number' || !Number.isFinite(item.target) || !Number.isInteger(item.target)) {
      throw new ErrorResponse(`goals[${i}].target must be a finite integer`, 400)
    }
    const bounds = GOAL_BOUNDS[label]
    if (item.target < bounds.min || item.target > bounds.max) {
      throw new ErrorResponse(
        `goals[${i}].target must be between ${bounds.min} and ${bounds.max}`, 400,
      )
    }
    if (item.icon !== undefined && !ALLOWED_ICONS.includes(item.icon)) {
      throw new ErrorResponse(`goals[${i}].icon is not allowed`, 400)
    }
    if (item.color !== undefined && !ALLOWED_COLORS.includes(item.color)) {
      throw new ErrorResponse(`goals[${i}].color is not allowed`, 400)
    }
    return {
      label,
      target: item.target,
      icon: item.icon ?? 'flag',
      color: item.color ?? 'primary',
    }
  })
}

export default { validateGoalsArray, clampGoalTarget, ALLOWED_GOAL_LABELS, GOAL_KEYS, GOAL_BOUNDS }

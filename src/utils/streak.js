import { dayKey } from './learning.js'

export function previousDayKey(key) {
  const date = new Date(`${key}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() - 1)
  return date.toISOString().slice(0, 10)
}

/**
 * Count consecutive local-calendar days ending today or yesterday.
 * Day keys must already be in the target timezone (YYYY-MM-DD).
 */
export function calculateStreak(dayKeys, now = new Date(), zone = 'Asia/Ho_Chi_Minh') {
  const today = dayKey(now, zone)
  const yesterday = previousDayKey(today)
  const unique = [...new Set((dayKeys || []).filter((d) => Boolean(d) && d <= today))].sort()
  const hasActivityToday = unique.includes(today)
  const last = unique[unique.length - 1]

  if (!last || (last !== today && last !== yesterday)) {
    return { streakDays: 0, hasActivityToday, lastActivityDate: last || null }
  }

  let streakDays = 0
  let cursor = last
  while (unique.includes(cursor)) {
    streakDays += 1
    cursor = previousDayKey(cursor)
  }

  return { streakDays, hasActivityToday, lastActivityDate: last }
}

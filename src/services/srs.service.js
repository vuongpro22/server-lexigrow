/**
 * SM-2 Spaced Repetition Algorithm
 *
 * Rating scale:
 *   1 = Again  (blackout — complete failure)
 *   2 = Hard   (recalled, but with serious difficulty — still counts as a pass)
 *   3 = Good   (correct with some hesitation)
 *   4 = Easy   (perfect recall with no effort)
 *
 * References: https://www.supermemo.com/en/archives1990-2015/english/ol/sm2
 */

import { dayBoundary } from '../utils/learning.js'
const EF_MIN = 1.3
const EF_DEFAULT = 2.5

// SM-2 quality score for each 1-4 self rating.
// 1=Again → q=0 (failed recall: reset the streak)
// 2=Hard  → q=3 (recalled with serious difficulty: pass, but barely)
// 3=Good  → q=4
// 4=Easy  → q=5
export const SM2_QUALITY = { 1: 0, 2: 3, 3: 4, 4: 5 }
export const sm2Quality = (rating) => SM2_QUALITY[rating]

/**
 * Calculate next SRS state from the current state and the user's rating.
 *
 * @param {object} current
 * @param {number} current.easeFactor  - current EF (default 2.5)
 * @param {number} current.reviewInterval - current interval in days (default 1)
 * @param {number} current.reviewCount  - number of successful reviews so far
 * @param {number} rating - 1 (Again) | 2 (Hard) | 3 (Good) | 4 (Easy)
 * @returns {{ nextReviewDate: Date, easeFactor: number, reviewInterval: number, reviewCount: number, masteryLevel: string }}
 */
export function calculateSM2(current, rating, { now = new Date(), timezone = Intl.DateTimeFormat().resolvedOptions().timeZone, algorithm = 'legacy' } = {}) {
  if (![1, 2, 3, 4].includes(rating)) {
    throw new Error('Rating must be 1 (Again), 2 (Hard), 3 (Good), or 4 (Easy)')
  }

  let { easeFactor = EF_DEFAULT, reviewInterval = 1, reviewCount = 0 } = current
  if (!Number.isFinite(easeFactor) || easeFactor < 1.3 || !Number.isSafeInteger(reviewInterval) || reviewInterval < 1 || !Number.isSafeInteger(reviewCount) || reviewCount < 0) {
    throw new Error('Invalid SRS state')
  }

  // SM-2 quality score: map 1-4 rating to the 0-5 quality q used in original SM-2
  const q = sm2Quality(rating)

  // Update ease factor: EF' = EF + (0.1 - (5-q)*(0.08 + (5-q)*0.02))
  const newEF = Math.max(EF_MIN, easeFactor + 0.1 - (5 - q) * (0.08 + (5 - q) * 0.02))

  let newInterval
  let newReviewCount

  if (q < 3) {
    // Rating 1 (Again): failed recall — reset the streak and see the word again
    // tomorrow. Only this rating resets reviewCount.
    newInterval = 1
    newReviewCount = 0
  } else if (rating === 2) {
    // Rating 2 (Hard): the learner recalled the word, but with serious
    // difficulty. SM-2 treats q=3 as a pass, so the streak is preserved and the
    // interval grows only slightly instead of restarting from 1 day.
    newReviewCount = reviewCount + 1
    newInterval = newReviewCount === 1
      ? 1
      : Math.max(reviewInterval + 1, Math.round(reviewInterval * 1.2))
  } else {
    // Successful recall
    newReviewCount = reviewCount + 1
    if (newReviewCount === 1) {
      newInterval = 1
    } else if (newReviewCount === 2) {
      newInterval = 6
    } else {
      newInterval = Math.round(reviewInterval * (algorithm === 'sm2' ? easeFactor : newEF))
    }
    // Rating 4 (Easy): give a small bonus interval
    if (rating === 4 && algorithm === 'legacy') {
      newInterval = Math.round(newInterval * 1.3)
    }
  }

  newInterval = Math.min(newInterval, 36500)
  const nextReviewDate = dayBoundary(now, newInterval, timezone)

  // Derive the recognition state from SM-2. 'mastered' is intentionally never
  // produced here: it is earned only by verified essay usage (mastery pipeline),
  // so reviews cannot fake mastery.
  const masteryLevel = newReviewCount === 0 ? 'new' : 'learning'

  return {
    nextReviewDate,
    easeFactor: Math.round(newEF * 1000) / 1000, // round to 3dp for storage
    reviewInterval: newInterval,
    reviewCount: newReviewCount,
    masteryLevel,
  }
}

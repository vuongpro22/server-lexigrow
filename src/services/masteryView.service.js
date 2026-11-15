import WordUsageEvidence from '../models/WordUsageEvidence.js'
import mongoose from 'mongoose'
import { masteredPipeline } from './wordEvidence.service.js'

const normalize = (word) => String(word || '').trim().toLowerCase()

/**
 * Single source of truth for mastery.
 *
 * `mastered` is earned only by using a word correctly, unassisted, in at least
 * two independent essays written on two different local days (see
 * masteredPipeline). The SRS engine owns only the recognition states
 * (new / learning), so every screen must read the effective level from here.
 */
export async function getMasteredWords(studentId) {
  // Aggregations do not cast strings, and route params arrive as strings.
  const id = typeof studentId === 'string' && mongoose.isValidObjectId(studentId)
    ? new mongoose.Types.ObjectId(studentId)
    : studentId
  const rows = await WordUsageEvidence.aggregate(masteredPipeline(id))
  return new Set(
    rows
      .map((row) => normalize(row._id))
      .filter(Boolean),
  )
}

export function effectiveMastery(word, masteredSet) {
  const current = word?.masteryLevel || 'new'
  if (masteredSet?.has(normalize(word?.word))) return 'mastered'
  // A stale stored value can never keep a word mastered without evidence.
  return current === 'mastered' ? 'learning' : current
}

export function withEffectiveMastery(word, masteredSet) {
  const plain = typeof word?.toObject === 'function' ? word.toObject() : { ...word }
  const masteryLevel = effectiveMastery(plain, masteredSet)
  return { ...plain, masteryLevel, isMastered: masteryLevel === 'mastered' }
}

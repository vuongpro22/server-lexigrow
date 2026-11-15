/**
 * One-off migration: align the stored recognition level with the single
 * mastery source of truth (verified essay evidence).
 *
 * Dry run by default:
 *   node scripts/backfillMasteryUnification.mjs
 * Apply:
 *   node scripts/backfillMasteryUnification.mjs --apply
 */
import 'dotenv/config'
import mongoose from 'mongoose'
import connectDB from '../src/config/db.js'
import Vocabulary from '../src/models/Vocabulary.js'
import { effectiveMastery, getMasteredWords } from '../src/services/masteryView.service.js'

async function main() {
  const apply = process.argv.includes('--apply')
  await connectDB()

  const students = await Vocabulary.distinct('student')
  const demote = []
  const promote = []

  for (const student of students) {
    const mastered = await getMasteredWords(student)
    const words = await Vocabulary.find({ student }).select('word masteryLevel').lean()
    for (const word of words) {
      const target = effectiveMastery(word, mastered)
      if (target === word.masteryLevel) continue
      const row = { student, word: word.word, from: word.masteryLevel, to: target }
      if (word.masteryLevel === 'mastered') demote.push(row)
      else promote.push(row)
    }
  }

  console.log(`Students scanned: ${students.length}`)
  console.log(`Demote (stored mastered, no evidence): ${demote.length}`)
  console.log(`Promote (evidence verified, stored lower): ${promote.length}`)
  for (const row of [...demote, ...promote].slice(0, 20)) {
    console.log(`  ${row.word}: ${row.from} -> ${row.to}`)
  }

  if (!apply) {
    console.log('\nDry run only. Re-run with --apply to write the changes.')
    await mongoose.disconnect()
    return
  }

  const byTarget = [...demote, ...promote].reduce((map, row) => {
    const key = `${row.student}:${row.to}`
    if (!map.has(key)) map.set(key, { student: row.student, to: row.to, words: [] })
    map.get(key).words.push(row.word)
    return map
  }, new Map())

  let modified = 0
  for (const { student, to, words } of byTarget.values()) {
    const result = await Vocabulary.updateMany(
      { student, word: { $in: words } },
      { $set: { masteryLevel: to } },
    )
    modified += result.modifiedCount
  }

  console.log(`\nUpdated ${modified} vocabulary documents.`)
  await mongoose.disconnect()
}

main().catch(async (err) => {
  console.error(err)
  await mongoose.disconnect().catch(() => {})
  process.exitCode = 1
})

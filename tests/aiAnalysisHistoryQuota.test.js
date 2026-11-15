import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { MongoMemoryServer } from 'mongodb-memory-server'
import mongoose from 'mongoose'
import AIAnalysis from '../src/models/AIAnalysis.js'
import AIAnalysisHistory from '../src/models/AIAnalysisHistory.js'

let mongo
beforeAll(async () => {
  mongo = await MongoMemoryServer.create()
  await mongoose.connect(mongo.getUri())
  await AIAnalysisHistory.init()
}, 180000)
afterAll(async () => {
  await mongoose.disconnect()
  await mongo?.stop()
})
beforeEach(async () => {
  await Promise.all([AIAnalysis.deleteMany({}), AIAnalysisHistory.deleteMany({})])
})

// The outbox writes history with $setOnInsert. Mongoose drops unknown paths from
// that payload, so the schema must declare every field the outbox sends.
describe('AIAnalysisHistory persists the quota audit trail', () => {
  const entry = {
    essay: new mongoose.Types.ObjectId(),
    student: new mongoose.Types.ObjectId(),
    contentRevision: 0,
    contentHash: 'hash-1',
    requestId: 'essay-submit:essay-1:0',
    rubricVersion: 'rubric-v1-cefr',
    overallScore: 7.5,
    quota: {
      student: new mongoose.Types.ObjectId(),
      requestId: 'essay-submit:essay-1:0',
      day: '2026-11-11',
      outcome: 'consume',
    },
  }

  it('keeps the quota block written through the outbox upsert', async () => {
    await AIAnalysisHistory.updateOne(
      { requestId: entry.requestId },
      { $setOnInsert: { ...entry, analysisId: new mongoose.Types.ObjectId() } },
      { upsert: true },
    )
    const stored = await AIAnalysisHistory.findOne({ requestId: entry.requestId }).lean()
    expect(stored.quota).toBeTruthy()
    expect(stored.quota.outcome).toBe('consume')
    expect(stored.quota.day).toBe('2026-11-11')
    expect(String(stored.quota.requestId)).toBe(entry.requestId)
  })

  it('stores a null quota for unmetered grading instead of dropping the field', async () => {
    const requestId = 'essay-analysis:essay-2:0'
    await AIAnalysisHistory.updateOne(
      { requestId },
      { $setOnInsert: { essay: entry.essay, requestId, quota: null } },
      { upsert: true },
    )
    const stored = await AIAnalysisHistory.findOne({ requestId }).lean()
    expect(stored).toBeTruthy()
    expect(stored.quota).toBeNull()
  })
})

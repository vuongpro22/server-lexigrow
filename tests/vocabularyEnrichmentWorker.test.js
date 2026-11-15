import { beforeAll, afterAll, beforeEach, describe, it, expect, vi } from 'vitest'
import { MongoMemoryServer } from 'mongodb-memory-server'
import mongoose from 'mongoose'

vi.mock('../src/services/ai.service.js', () => ({
  enrichWordsList: vi.fn().mockResolvedValue([
    {
      ipa: '/rɪˈzɪliənt/',
      partOfSpeech: 'adjective',
      definition: 'Able to recover quickly from difficulty.',
      exampleSentence: 'The resilient team recovered after the setback.',
      synonyms: ['tough'],
      antonyms: [],
    },
  ]),
}))

import Vocabulary from '../src/models/Vocabulary.js'
import { processPendingVocabularyEnrichment } from '../src/services/vocabularyEnrichment.service.js'

let mongo

beforeAll(async () => {
  mongo = await MongoMemoryServer.create()
  await mongoose.connect(mongo.getUri())
}, 180_000)

afterAll(async () => {
  await mongoose.disconnect()
  await mongo?.stop()
})

beforeEach(async () => {
  await Vocabulary.deleteMany({})
})

const pendingWord = () => ({
  student: new mongoose.Types.ObjectId(),
  word: 'resilient',
  enrichmentStatus: 'pending',
})

describe('vocabulary enrichment worker', () => {
  it('recovers a word left pending by a restart', async () => {
    const word = await Vocabulary.create(pendingWord())
    await Vocabulary.collection.updateOne(
      { _id: word._id },
      { $set: { updatedAt: new Date(Date.now() - 10 * 60 * 1000) } },
    )

    const result = await processPendingVocabularyEnrichment()

    expect(result.processed).toBe(1)
    const updated = await Vocabulary.findById(word._id).lean()
    expect(updated.enrichmentStatus).toBe('done')
    expect(updated.definition).toContain('recover quickly')
    expect(updated.ipa).toBe('/rɪˈzɪliənt/')
  })

  it('ignores a pending word while the immediate enrichment is still fresh', async () => {
    await Vocabulary.create(pendingWord())

    const result = await processPendingVocabularyEnrichment()

    expect(result.processed).toBe(0)
  })
})

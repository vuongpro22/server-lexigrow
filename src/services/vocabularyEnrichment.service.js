import Vocabulary from '../models/Vocabulary.js'

const STALE_PENDING_MS = 5 * 60 * 1000
const MAX_PER_TICK = 10

/**
 * Fill in IPA / definition / examples for a word that was just saved.
 *
 * Called after the request has been answered (and by the background worker),
 * so adding a word never blocks the UI on the AI provider. Empty provider
 * answers are marked failed instead of being cached as if they were real
 * enrichment.
 */
export async function enrichVocabularyWord(wordId, normalizedWord) {
  try {
    const { enrichWordsList } = await import('./ai.service.js')
    const enrichedList = await enrichWordsList([normalizedWord])
    const enriched = enrichedList?.[0]
    if (!enriched || !String(enriched.definition || '').trim()) {
      await Vocabulary.updateOne({ _id: wordId }, { $set: { enrichmentStatus: 'failed' } })
      return
    }
    await Vocabulary.updateOne(
      { _id: wordId },
      {
        $set: {
          ipa: enriched.ipa || '',
          partOfSpeech: enriched.partOfSpeech || '',
          definition: enriched.definition || '',
          exampleSentence: enriched.exampleSentence || '',
          synonyms: enriched.synonyms || [],
          antonyms: enriched.antonyms || [],
          enrichmentStatus: 'done',
        },
      },
    )
  } catch (err) {
    console.error('Vocabulary enrichment failed:', err.message)
    await Vocabulary.updateOne({ _id: wordId }, { $set: { enrichmentStatus: 'failed' } }).catch(() => {})
  }
}

/**
 * DB-backed queue: pick up words that are still pending after a restart or a
 * previous attempt that never completed. The grace period avoids racing the
 * immediate enrichment started by createVocabulary.
 */
export async function processPendingVocabularyEnrichment({ now = new Date(), limit = MAX_PER_TICK } = {}) {
  const pending = await Vocabulary.find({
    enrichmentStatus: 'pending',
    updatedAt: { $lt: new Date(now.getTime() - STALE_PENDING_MS) },
  })
    .select('_id word')
    .sort({ createdAt: 1 })
    .limit(limit)
    .lean()

  let processed = 0
  for (const word of pending) {
    await enrichVocabularyWord(word._id, word.word)
    processed += 1
  }
  return { processed }
}

let worker = null

export function startVocabularyEnrichmentWorker() {
  if (process.env.NODE_ENV === 'test' || worker) return worker

  const tick = () =>
    processPendingVocabularyEnrichment().catch((err) => {
      console.error('Vocabulary enrichment worker failed:', err.message)
    })

  worker = setInterval(tick, 2 * 60 * 1000)
  worker.unref?.()
  // Recover pending words left by the previous process right away.
  tick()
  return worker
}

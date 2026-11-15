import cron from 'node-cron'
import AIAnalysis from '../models/AIAnalysis.js'
import AIAnalysisHistory from '../models/AIAnalysisHistory.js'
import { settleHistoryQuota } from './aiQuota.js'

export async function flushAIAnalysisHistoryOutbox({ essayId, batchSize = 100 } = {}) {
  const filter = { historyOutbox: { $elemMatch: { requestId: { $exists: true, $ne: '' } } } }
  if (essayId) filter.essay = essayId
  const docs = await AIAnalysis.find(filter)
    .select('+historyOutbox')
    .sort({ _id: 1 })
    .limit(Math.min(500, Math.max(1, Number(batchSize) || 100)))

  const result = { checked: 0, delivered: 0, failed: 0 }
  for (const doc of docs) {
    for (const entry of doc.historyOutbox || []) {
      result.checked++
      if (!entry?.requestId) {
        result.failed++
        continue
      }
      try {
        const historyWrite = await AIAnalysisHistory.updateOne(
          { requestId: entry.requestId },
          { $setOnInsert: { ...entry, analysisId: doc._id } },
          { upsert: true },
        )
        if (historyWrite?.acknowledged !== true) {
          throw Object.assign(new Error('History write was not acknowledged'), { code: 'HISTORY_WRITE_UNACKNOWLEDGED' })
        }
      } catch (error) {
        if (error?.code !== 11000) {
          result.failed++
          console.warn('[AIAnalysisHistoryOutbox] Delivery failed; payload retained for retry', {
            essayId: String(doc.essay),
            requestId: entry.requestId,
            code: error?.code || 'HISTORY_WRITE_FAILED',
          })
          continue
        }
      }

      try {
        const quotaResult = await settleHistoryQuota(entry)
        if (entry.quota && !quotaResult.settled) {
          result.failed++
          console.warn('[AIAnalysisHistoryOutbox] Quota settlement failed; payload retained for retry', {
            essayId: String(doc.essay),
            requestId: entry.requestId,
            code: quotaResult.reason || 'QUOTA_SETTLEMENT_FAILED',
          })
          continue
        }
      } catch (error) {
        result.failed++
        console.warn('[AIAnalysisHistoryOutbox] Quota settlement failed; payload retained for retry', {
          essayId: String(doc.essay),
          requestId: entry.requestId,
          code: error?.code || 'QUOTA_SETTLEMENT_FAILED',
        })
        continue
      }

      try {
        const cleanup = await AIAnalysis.updateOne(
          { _id: doc._id, 'historyOutbox.requestId': entry.requestId },
          { $pull: { historyOutbox: { requestId: entry.requestId } } },
        )
        if (cleanup?.acknowledged !== true) {
          throw Object.assign(new Error('Outbox cleanup was not acknowledged'), { code: 'OUTBOX_CLEANUP_UNACKNOWLEDGED' })
        }
        result.delivered++
      } catch (error) {
        result.failed++
        console.warn('[AIAnalysisHistoryOutbox] Cleanup failed; idempotent retry retained', {
          essayId: String(doc.essay),
          requestId: entry.requestId,
          code: error?.code || 'OUTBOX_CLEANUP_FAILED',
        })
      }
    }
  }
  return result
}

export function scheduleAIAnalysisHistoryOutbox() {
  return cron.schedule('*/2 * * * *', async () => {
    try {
      console.info('[AIAnalysisHistoryOutbox] Flush completed:', await flushAIAnalysisHistoryOutbox())
    } catch (error) {
      console.error('[AIAnalysisHistoryOutbox] Flush failed; pending records remain queued:', error?.message || 'unknown error')
    }
  }, { noOverlap: true, name: 'ai-analysis-history-outbox' })
}

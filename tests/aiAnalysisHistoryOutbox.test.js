import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  analysisFind: vi.fn(),
  historyUpdate: vi.fn(),
  analysisUpdate: vi.fn(),
}))
vi.mock('../src/models/AIAnalysis.js', () => ({ default: { find: mocks.analysisFind, updateOne: mocks.analysisUpdate } }))
vi.mock('../src/models/AIAnalysisHistory.js', () => ({ default: { updateOne: mocks.historyUpdate } }))
vi.mock('../src/services/aiQuota.js', () => ({
  settleHistoryQuota: vi.fn().mockResolvedValue({ settled: false, reason: 'unmetered_history' }),
}))

import { flushAIAnalysisHistoryOutbox } from '../src/services/aiAnalysisHistoryOutbox.scheduler.js'

const entry = { essay: 'essay-1', requestId: 'request-1', overallScore: 7 }
const doc = { _id: 'analysis-1', essay: 'essay-1', historyOutbox: [entry] }
const query = { select: vi.fn().mockReturnThis(), sort: vi.fn().mockReturnThis(), limit: vi.fn() }

beforeEach(() => {
  vi.resetAllMocks()
  mocks.analysisFind.mockReturnValue(query)
  query.select.mockReturnThis()
  query.sort.mockReturnThis()
  query.limit.mockResolvedValue([doc])
  mocks.historyUpdate.mockResolvedValue({ acknowledged: true, upsertedCount: 1 })
  mocks.analysisUpdate.mockResolvedValue({ acknowledged: true, modifiedCount: 1 })
})

describe('AI analysis history durable outbox', () => {
  it('queries only retryable entries and writes history idempotently', async () => {
    const result = await flushAIAnalysisHistoryOutbox()
    expect(result).toEqual({ checked: 1, delivered: 1, failed: 0 })
    expect(mocks.analysisFind).toHaveBeenCalledWith({
      historyOutbox: { $elemMatch: { requestId: { $exists: true, $ne: '' } } },
    })
    expect(mocks.historyUpdate).toHaveBeenCalledWith(
      { requestId: 'request-1' },
      { $setOnInsert: { ...entry, analysisId: 'analysis-1' } },
      { upsert: true },
    )
    expect(mocks.analysisUpdate).toHaveBeenCalledWith(
      { _id: 'analysis-1', 'historyOutbox.requestId': 'request-1' },
      { $pull: { historyOutbox: { requestId: 'request-1' } } },
    )
  })

  it('retains outbox payload when history persistence fails', async () => {
    mocks.historyUpdate.mockRejectedValue(new Error('history collection unavailable'))
    const result = await flushAIAnalysisHistoryOutbox({ essayId: 'essay-1' })
    expect(result).toEqual({ checked: 1, delivered: 0, failed: 1 })
    expect(mocks.analysisUpdate).not.toHaveBeenCalled()
  })

  it('retains outbox payload when MongoDB does not acknowledge the history write', async () => {
    mocks.historyUpdate.mockResolvedValue({ acknowledged: false })
    const result = await flushAIAnalysisHistoryOutbox({ essayId: 'essay-1' })
    expect(result).toEqual({ checked: 1, delivered: 0, failed: 1 })
    expect(mocks.analysisUpdate).not.toHaveBeenCalled()
  })

  it('treats a duplicate request id as already persisted and cleans the outbox', async () => {
    mocks.historyUpdate.mockRejectedValue(Object.assign(new Error('duplicate'), { code: 11000 }))
    const result = await flushAIAnalysisHistoryOutbox()
    expect(result).toEqual({ checked: 1, delivered: 1, failed: 0 })
    expect(mocks.analysisUpdate).toHaveBeenCalledOnce()
  })

  it('keeps outbox payload on errors other than a duplicate key', async () => {
    mocks.historyUpdate.mockRejectedValue(Object.assign(new Error('write concern failed'), { code: 64 }))
    const result = await flushAIAnalysisHistoryOutbox()
    expect(result).toEqual({ checked: 1, delivered: 0, failed: 1 })
    expect(mocks.analysisUpdate).not.toHaveBeenCalled()
  })

  it('does not report delivery when outbox cleanup is unacknowledged', async () => {
    mocks.analysisUpdate.mockResolvedValue({ acknowledged: false })
    const result = await flushAIAnalysisHistoryOutbox()
    expect(result).toEqual({ checked: 1, delivered: 0, failed: 1 })
  })
})

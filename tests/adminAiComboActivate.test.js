import { beforeEach, describe, expect, it, vi } from 'vitest'

// Activating a combo used to read the document, deactivate its rivals, then
// save the stale in-memory copy. Two overlapping activations could interleave
// and leave both combos active, so the response must come from the update.
const AIModelCombo = {
  findById: vi.fn(),
  updateMany: vi.fn(),
  findOneAndUpdate: vi.fn(),
}
const AIProviderModel = { find: vi.fn().mockReturnValue({ select: vi.fn().mockResolvedValue([]) }) }
const AIProviderAccount = { findById: vi.fn(), countDocuments: vi.fn().mockResolvedValue(0) }

vi.mock('../src/models/AIModelCombo.js', () => ({ default: AIModelCombo }))
vi.mock('../src/models/AIProviderModel.js', () => ({ default: AIProviderModel }))
vi.mock('../src/models/AIProviderAccount.js', () => ({ default: AIProviderAccount }))
vi.mock('../src/models/Config.js', () => ({ default: { updateOne: vi.fn() } }))
vi.mock('../src/utils/auditLogger.js', () => ({ logAction: vi.fn().mockResolvedValue() }))
vi.mock('../src/services/aiGateway.service.js', () => ({ testAIProviderAccount: vi.fn() }))

const { activateAICombo } = await import('../src/controllers/aiProvider.controller.js')

const res = () => ({ status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() })

const combo = {
  _id: 'combo_a',
  name: 'A',
  routes: ['essay_analysis'],
  candidates: [{ model: 'model_1', order: 1, enabled: true }],
  enabled: true,
  active: false,
  maxAttempts: 3,
  timeoutMs: 30000,
  maxCostUsd: null,
  version: 4,
  toObject() { return this },
}

beforeEach(() => {
  AIModelCombo.findById.mockReset()
  AIModelCombo.updateMany.mockReset().mockResolvedValue({ modifiedCount: 1 })
  AIModelCombo.findOneAndUpdate.mockReset()
  // The controller awaits the Mongoose query directly, so the mock resolves.
  AIModelCombo.findById.mockResolvedValue(combo)
  // validateComboCandidates: every requested model exists and its account is enabled.
  AIProviderModel.find.mockReturnValue({
    select: vi.fn().mockResolvedValue([{ account: 'account_1' }]),
  })
  AIProviderAccount.countDocuments.mockResolvedValue(1)
})

describe('activateAICombo', () => {
  it('deactivates rivals first, then returns the freshly updated combo', async () => {
    AIModelCombo.findOneAndUpdate.mockReturnValue({
      lean: vi.fn().mockResolvedValue({ ...combo, active: true, version: 5 }),
    })

    const response = res()
    await activateAICombo({ params: { id: 'combo_a' }, user: { _id: 'admin_1' } }, response, vi.fn())

    expect(AIModelCombo.updateMany).toHaveBeenCalledWith(
      { _id: { $ne: 'combo_a' }, routes: { $in: ['essay_analysis'] } },
      { $set: { active: false } },
    )
    expect(AIModelCombo.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: 'combo_a' },
      { $set: { active: true, enabled: true }, $inc: { version: 1 } },
      { returnDocument: 'after' },
    )
    // The payload must be the post-update document, not the stale pre-read one.
    expect(response.json.mock.calls[0][0].data).toEqual(expect.objectContaining({ active: true, version: 5 }))
  })

  it('404s when the combo disappears between the read and the update', async () => {
    AIModelCombo.findOneAndUpdate.mockReturnValue({ lean: vi.fn().mockResolvedValue(null) })
    const next = vi.fn()

    await activateAICombo({ params: { id: 'combo_a' }, user: { _id: 'admin_1' } }, res(), next)

    expect(next.mock.calls[0][0].statusCode).toBe(404)
  })
})

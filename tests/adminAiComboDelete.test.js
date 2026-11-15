import { beforeEach, describe, expect, it, vi } from 'vitest'

// Deleting a combo that DEFAULT_AI_COMBO still points at leaves the gateway
// looking up a dead id on every request before it falls back to the active
// combo. The delete must clear that pointer.
const AIModelCombo = { deleteOne: vi.fn().mockResolvedValue({ deletedCount: 1 }) }
const Config = { updateOne: vi.fn().mockResolvedValue({ matchedCount: 1 }) }
const AIProviderAccount = { findById: vi.fn() }
const AIProviderModel = { find: vi.fn() }

vi.mock('../src/models/AIModelCombo.js', () => ({ default: AIModelCombo }))
vi.mock('../src/models/Config.js', () => ({ default: Config }))
vi.mock('../src/models/AIProviderAccount.js', () => ({ default: AIProviderAccount }))
vi.mock('../src/models/AIProviderModel.js', () => ({ default: AIProviderModel }))
vi.mock('../src/utils/auditLogger.js', () => ({ logAction: vi.fn().mockResolvedValue() }))
vi.mock('../src/services/aiGateway.service.js', () => ({ testAIProviderAccount: vi.fn() }))

const { deleteAICombo } = await import('../src/controllers/aiProvider.controller.js')

const res = () => ({ status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() })

beforeEach(() => {
  AIModelCombo.deleteOne.mockClear()
  Config.updateOne.mockClear()
})

describe('deleteAICombo', () => {
  it('clears DEFAULT_AI_COMBO when it points at the deleted combo', async () => {
    await deleteAICombo({ params: { id: 'combo_1' }, user: { _id: 'admin_1' } }, res(), vi.fn())

    expect(Config.updateOne).toHaveBeenCalledWith(
      { key: 'DEFAULT_AI_COMBO', value: 'combo_1' },
      { $set: { value: '' } },
    )
  })

  it('reports a missing combo without touching the config pointer', async () => {
    AIModelCombo.deleteOne.mockResolvedValueOnce({ deletedCount: 0 })
    const next = vi.fn()

    await deleteAICombo({ params: { id: 'gone' }, user: { _id: 'admin_1' } }, res(), next)

    // asyncHandler forwards the thrown ErrorResponse to next().
    expect(next).toHaveBeenCalledTimes(1)
    expect(next.mock.calls[0][0].statusCode).toBe(404)
    expect(Config.updateOne).not.toHaveBeenCalled()
  })
})

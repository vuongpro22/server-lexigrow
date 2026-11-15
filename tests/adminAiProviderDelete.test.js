import { beforeEach, describe, expect, it, vi } from 'vitest'

// Deleting the provider that supplies the last candidate of a combo used to
// pull the candidate and leave an empty combo behind. An empty combo can never
// be activated again (validateComboCandidates requires >= 1 candidate), so the
// delete must be refused while a combo still depends on it.
const AIProviderAccount = {
  findById: vi.fn(),
  deleteOne: vi.fn(),
}
const AIProviderModel = {
  find: vi.fn(),
  deleteMany: vi.fn(),
}
const AIModelCombo = {
  find: vi.fn(),
  updateMany: vi.fn(),
}

vi.mock('../src/models/AIProviderAccount.js', () => ({ default: AIProviderAccount }))
vi.mock('../src/models/AIProviderModel.js', () => ({ default: AIProviderModel }))
vi.mock('../src/models/AIModelCombo.js', () => ({ default: AIModelCombo }))
vi.mock('../src/models/Config.js', () => ({ default: { updateOne: vi.fn() } }))
vi.mock('../src/utils/auditLogger.js', () => ({ logAction: vi.fn().mockResolvedValue() }))
vi.mock('../src/services/aiGateway.service.js', () => ({ testAIProviderAccount: vi.fn() }))

const { deleteAIProvider } = await import('../src/controllers/aiProvider.controller.js')

const res = () => ({ status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() })

// Each query chain is awaited at its own last step: account/model use
// .select(), and the combo lookup ends with .lean().
const accountQuery = (value) => ({ select: vi.fn().mockResolvedValue(value) })
const modelsQuery = (value) => ({ select: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue(value) }) })
const combosQuery = (value) => ({ select: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue(value) }) })

beforeEach(() => {
  vi.clearAllMocks()
  AIProviderAccount.findById.mockReturnValue(accountQuery({ _id: 'acc_1', name: 'Groq A', provider: 'groq' }))
  AIProviderModel.find.mockReturnValue(modelsQuery([{ _id: 'model_1' }]))
  AIProviderAccount.deleteOne.mockResolvedValue({ deletedCount: 1 })
})

describe('deleteAIProvider', () => {
  it('refuses when the provider is the only candidate of a combo', async () => {
    AIModelCombo.find.mockReturnValue(combosQuery([
      { name: 'Solo chain', candidates: [{ model: 'model_1' }, { model: 'model_1' }] },
    ]))
    const next = vi.fn()

    await deleteAIProvider({ params: { id: 'acc_1' }, user: { _id: 'admin_1' } }, res(), next)

    expect(next).toHaveBeenCalledTimes(1)
    expect(next.mock.calls[0][0].statusCode).toBe(409)
    expect(next.mock.calls[0][0].message).toContain('Solo chain')
    expect(AIProviderAccount.deleteOne).not.toHaveBeenCalled()
  })

  it('allows the delete when the combo keeps another provider', async () => {
    AIModelCombo.find.mockReturnValue(combosQuery([
      { name: 'Mixed chain', candidates: [{ model: 'model_1' }, { model: 'model_2' }] },
    ]))

    await deleteAIProvider({ params: { id: 'acc_1' }, user: { _id: 'admin_1' } }, res(), vi.fn())

    expect(AIModelCombo.updateMany).toHaveBeenCalled()
    expect(AIProviderAccount.deleteOne).toHaveBeenCalledWith({ _id: 'acc_1' })
  })
})

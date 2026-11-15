import { vi, describe, it, expect, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  modelFind: vi.fn(),
  accountCount: vi.fn(),
  comboCreate: vi.fn(),
}))

vi.mock('../src/config/db.js', () => ({ default: vi.fn().mockResolvedValue() }))
vi.mock('../src/models/AIProviderModel.js', () => ({
  default: { find: (...a) => mocks.modelFind(...a) },
}))
vi.mock('../src/models/AIProviderAccount.js', () => ({
  default: { countDocuments: (...a) => mocks.accountCount(...a) },
}))
vi.mock('../src/models/AIModelCombo.js', () => ({
  default: { create: (...a) => mocks.comboCreate(...a), find: vi.fn(), updateMany: vi.fn() },
}))
vi.mock('../src/utils/auditLogger.js', () => ({ logAction: vi.fn().mockResolvedValue() }))
vi.mock('../src/middleware/auth.middleware.js', () => ({
  protect: (req, res, next) => { req.user = { _id: 'admin_1', role: 'admin' }; next() },
  authorize: () => (req, res, next) => next(),
  optionalAuth: (req, res, next) => next(),
}))

import request from 'supertest'
import app from '../src/index.js'

beforeEach(() => vi.clearAllMocks())

describe('POST /api/admin/ai/providers/combos', () => {
  const payload = { name: 'c', routes: ['essay_analysis'], candidates: [{ model: 'm1', order: 0 }] }

  it('rejects a combo whose only model belongs to a disabled provider account', async () => {
    mocks.modelFind.mockReturnValue({ select: () => Promise.resolve([{ _id: 'm1', account: 'acc1' }]) })
    mocks.accountCount.mockResolvedValue(0)

    const res = await request(app).post('/api/admin/ai/providers/combos').send(payload)

    expect(res.status).toBe(400)
    expect(mocks.comboCreate).not.toHaveBeenCalled()
  })
})

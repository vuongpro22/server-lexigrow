import { vi, describe, it, expect, beforeEach } from 'vitest'

vi.mock('../src/config/db.js', () => ({
  default: vi.fn().mockImplementation(() => Promise.resolve()),
}))

vi.mock('../src/models/WeeklyGoal.js', () => ({
  default: {
    findOne: vi.fn(),
    create: vi.fn(),
  },
}))

vi.mock('../src/middleware/auth.middleware.js', () => ({
  optionalAuth: (req, res, next) => next(),
  protect: (req, res, next) => {
    req.user = { _id: '507f1f77bcf86cd799439011', role: 'student', name: 'Mock Student' }
    next()
  },
  authorize: () => (req, res, next) => {
    next()
  },
}))

import request from 'supertest'
import app from '../src/index.js'
import WeeklyGoal from '../src/models/WeeklyGoal.js'

const VALID_ID = '507f1f77bcf86cd799439012'
const validGoals = () => ([
  { label: 'New Words', target: 20 },
  { label: 'Essays Written', target: 3 },
  { label: 'Writing Length (words)', target: 5000 },
  { label: 'Complexity Score', target: 8 },
])

describe('Goals validation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('POST /api/goals', () => {
    beforeEach(() => {
      WeeklyGoal.findOne.mockResolvedValue(null)
      WeeklyGoal.create.mockImplementation(async (doc) => ({ _id: VALID_ID, ...doc }))
    })

    it.each([
      ['string', 'not-an-array'],
      ['number', 42],
      ['object', { label: 'New Words', target: 20 }],
      ['null', null],
    ])('rejects non-array goals (%s) with 400', async (_, goals) => {
      const res = await request(app).post('/api/goals').send({ goals })
      expect(res.status).toBe(400)
      expect(WeeklyGoal.create).not.toHaveBeenCalled()
    })

    it('rejects missing goals with 400', async () => {
      const res = await request(app).post('/api/goals').send({})
      expect(res.status).toBe(400)
    })

    it('rejects an empty array with 400', async () => {
      const res = await request(app).post('/api/goals').send({ goals: [] })
      expect(res.status).toBe(400)
    })

    it('rejects more than 4 goals with 400', async () => {
      const goals = [...validGoals(), { label: 'New Words', target: 5 }]
      const res = await request(app).post('/api/goals').send({ goals })
      expect(res.status).toBe(400)
    })

    it('rejects non-object items with 400', async () => {
      const res = await request(app).post('/api/goals').send({ goals: ['New Words'] })
      expect(res.status).toBe(400)
    })

    it.each([
      ['missing label', { target: 20 }],
      ['empty label', { label: '  ', target: 20 }],
      ['unknown label', { label: 'Hacked Goal', target: 20 }],
      ['oversized label', { label: 'x'.repeat(61), target: 20 }],
    ])('rejects bad label (%s) with 400', async (_, item) => {
      const res = await request(app).post('/api/goals').send({ goals: [item] })
      expect(res.status).toBe(400)
    })

    it('rejects duplicate labels with 400', async () => {
      const goals = [{ label: 'New Words', target: 10 }, { label: 'New Words', target: 20 }]
      const res = await request(app).post('/api/goals').send({ goals })
      expect(res.status).toBe(400)
    })

    it.each([
      ['string target', '20'],
      ['NaN target', NaN],
      ['negative target', -5],
      ['zero target', 0],
      ['huge target', 1000000000000],
      ['float target', 7.5],
      ['missing target', undefined],
    ])('rejects bad target (%s) with 400', async (_, target) => {
      const item = target === undefined ? { label: 'New Words' } : { label: 'New Words', target }
      const res = await request(app).post('/api/goals').send({ goals: [item] })
      expect(res.status).toBe(400)
    })

    it('rejects out-of-range per-label targets with 400', async () => {
      const cases = [
        [{ label: 'Complexity Score', target: 11 }],
        [{ label: 'Writing Length (words)', target: 500 }],
        [{ label: 'New Words', target: 101 }],
      ]
      for (const goals of cases) {
        const res = await request(app).post('/api/goals').send({ goals })
        expect(res.status).toBe(400)
      }
    })

    it('rejects disallowed icon/color with 400', async () => {
      const res = await request(app).post('/api/goals').send({
        goals: [{ label: 'New Words', target: 20, icon: '<evil>', color: 'red' }],
      })
      expect(res.status).toBe(400)
    })

    it('strips client-sent current and creates with 201', async () => {
      const goals = validGoals().map((g) => ({ ...g, current: 9999 }))
      const res = await request(app).post('/api/goals').send({ goals })
      expect(res.status).toBe(201)
      const saved = WeeklyGoal.create.mock.calls[0][0].goals
      expect(saved.every((g) => g.current === undefined)).toBe(true)
      expect(saved).toHaveLength(4)
    })

    it('trims labels and applies icon/color defaults', async () => {
      const res = await request(app).post('/api/goals').send({
        goals: [{ label: '  New Words  ', target: 20 }],
      })
      expect(res.status).toBe(201)
      expect(WeeklyGoal.create.mock.calls[0][0].goals[0]).toMatchObject({
        label: 'New Words',
        target: 20,
        icon: 'flag',
        color: 'primary',
      })
    })
  })

  describe('PUT /api/goals/:id', () => {
    const doc = () => ({
      _id: VALID_ID,
      student: '507f1f77bcf86cd799439011',
      goals: [],
      save: vi.fn().mockResolvedValue(true),
    })

    it('rejects an invalid id with 400 (not 404)', async () => {
      const res = await request(app).put('/api/goals/abc').send({ goals: validGoals() })
      expect(res.status).toBe(400)
    })

    it('returns 404 for another student’s document', async () => {
      WeeklyGoal.findOne.mockResolvedValue(null)
      const res = await request(app).put(`/api/goals/${VALID_ID}`).send({ goals: validGoals() })
      expect(res.status).toBe(404)
    })

    it('rejects missing goals with 400', async () => {
      WeeklyGoal.findOne.mockResolvedValue(doc())
      const res = await request(app).put(`/api/goals/${VALID_ID}`).send({})
      expect(res.status).toBe(400)
    })

    it('rejects an empty array with 400', async () => {
      WeeklyGoal.findOne.mockResolvedValue(doc())
      const res = await request(app).put(`/api/goals/${VALID_ID}`).send({ goals: [] })
      expect(res.status).toBe(400)
    })

    it('strips forged current instead of persisting it', async () => {
      const d = doc()
      WeeklyGoal.findOne.mockResolvedValue(d)
      const res = await request(app).put(`/api/goals/${VALID_ID}`).send({
        goals: [{ label: 'New Words', target: 20, current: 9999 }],
      })
      expect(res.status).toBe(200)
      expect(d.save).toHaveBeenCalledTimes(1)
      expect(d.goals[0].current).toBeUndefined()
    })

    it('updates targets with 200 and strips current', async () => {
      const d = doc()
      WeeklyGoal.findOne.mockResolvedValue(d)
      const goals = validGoals().map((g) => ({ ...g, current: 5 }))
      const res = await request(app).put(`/api/goals/${VALID_ID}`).send({ goals })
      expect(res.status).toBe(200)
      expect(d.save).toHaveBeenCalledTimes(1)
      expect(d.goals.every((g) => g.current === undefined)).toBe(true)
    })
  })
})

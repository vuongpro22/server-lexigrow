import { vi, describe, it, expect, beforeEach } from 'vitest'

// Mock db connection
vi.mock('../src/config/db.js', () => ({
  default: vi.fn().mockImplementation(() => Promise.resolve())
}))

// Mock models
vi.mock('../src/models/Vocabulary.js', () => ({
  default: {
    countDocuments: vi.fn(),
    aggregate: vi.fn(),
  }
}))
vi.mock('../src/models/Essay.js', () => ({
  default: {
    find: vi.fn(),
    countDocuments: vi.fn(),
  }
}))
vi.mock('../src/models/AIAnalysis.js', () => ({
  default: {
    find: vi.fn(),
  }
}))
vi.mock('../src/models/User.js', () => ({
  default: {
    findById: vi.fn(),
    findOne: vi.fn(),
  }
}))
vi.mock('../src/models/Class.js', () => ({
  default: {
    find: vi.fn(),
  }
}))
vi.mock('../src/models/ReviewEvent.js', () => ({
  default: {
    find: vi.fn(),
  }
}))
vi.mock('../src/models/DailyQuest.js', () => ({
  default: {
    find: vi.fn(),
  }
}))
vi.mock('../src/models/LearningSession.js', () => ({
  default: {
    find: vi.fn(),
    countDocuments: vi.fn(),
  }
}))

// Mock protect middleware to inject a mock req.user
vi.mock('../src/middleware/auth.middleware.js', () => ({
  optionalAuth: (req, res, next) => next(),
  protect: (req, res, next) => {
    req.user = { _id: '507f1f77bcf86cd799439011', role: 'student', name: 'Mock Student' }
    next()
  },
  authorize: () => (req, res, next) => {
    next()
  }
}))

import request from 'supertest'
import app from '../src/index.js'
import Vocabulary from '../src/models/Vocabulary.js'
import Essay from '../src/models/Essay.js'
import AIAnalysis from '../src/models/AIAnalysis.js'
import ReviewEvent from '../src/models/ReviewEvent.js'
import DailyQuest from '../src/models/DailyQuest.js'
import LearningSession from '../src/models/LearningSession.js'

beforeEach(() => {
  vi.clearAllMocks()
  Essay.find.mockReturnValue({
    select: vi.fn().mockReturnThis(),
    lean: vi.fn().mockResolvedValue([]),
    distinct: vi.fn().mockResolvedValue([]),
  })
  LearningSession.find.mockReturnValue({
    select: vi.fn().mockReturnThis(),
    lean: vi.fn().mockResolvedValue([]),
  })
})

describe('Progress API - Weekly Comparison', () => {
  it('should return correct weekly comparison metrics', async () => {
    // 1. Mock vocabulary count (this week: 5, last week: 2)
    Vocabulary.countDocuments
      .mockResolvedValueOnce(5)
      .mockResolvedValueOnce(2)

    // 2. Mock essay queries for this week and last week
    const mockDistinctThisWeek = vi.fn().mockResolvedValue(['essay1'])
    const mockDistinctLastWeek = vi.fn().mockResolvedValue(['essay2'])

    Essay.find
      .mockReturnValueOnce({ distinct: mockDistinctThisWeek })
      .mockReturnValueOnce({ distinct: mockDistinctLastWeek })

    // 3. Mock AI Analysis results
    AIAnalysis.find
      .mockResolvedValueOnce([
        { scores: { vocabularyDiversity: 0.6, complexityIndex: 7 } }
      ])
      .mockResolvedValueOnce([
        { scores: { vocabularyDiversity: 0.8, complexityIndex: 9 } }
      ])

    const res = await request(app)
      .get('/api/progress/weekly-comparison')
      .expect(200)

    expect(res.body.success).toBe(true)
    expect(res.body.data.newWords.thisWeek).toBe(5)
    expect(res.body.data.newWords.lastWeek).toBe(2)
    expect(res.body.data.newWords.change).toBe(150) // (5 - 2)/2 * 100

    expect(res.body.data.ttr.thisWeek).toBe(0.6)
    expect(res.body.data.ttr.lastWeek).toBe(0.8)
    expect(res.body.data.ttr.change).toBe(-25) // (0.6 - 0.8)/0.8 * 100

    expect(res.body.data.complexity.thisWeek).toBe(7)
    expect(res.body.data.complexity.lastWeek).toBe(9)
    expect(res.body.data.complexity.change).toBe(-22) // (7 - 9)/9 * 100
  })
})

describe('Functions LG-46 to LG-49: progress overview, chart, milestones, and streak', () => {
  it('LG-46 returns overview metrics and calculates the current rank', async () => {
    Vocabulary.countDocuments
      .mockResolvedValueOnce(250)
      .mockResolvedValueOnce(10)
      .mockResolvedValueOnce(5)
    Essay.find.mockReturnValueOnce({
      distinct: vi.fn().mockResolvedValue(['essay-1']),
    })
    AIAnalysis.find.mockResolvedValue([{ scores: { vocabularyDiversity: 0.52 } }])
    Essay.countDocuments.mockResolvedValue(3)

    const res = await request(app).get('/api/progress/overview').expect(200)

    expect(res.body).toEqual({
      success: true,
      data: {
        totalVocab: 250,
        thisMonthWords: 10,
        growthRate: 100,
        avgTTR: 0.52,
        rank: 'B1',
        totalEssays: 3,
      },
    })
  })

  it('LG-46 handles a student with no learning data as the lower boundary', async () => {
    Vocabulary.countDocuments
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(0)
    Essay.find.mockReturnValueOnce({
      distinct: vi.fn().mockResolvedValue([]),
    })
    AIAnalysis.find.mockResolvedValue([])
    Essay.countDocuments.mockResolvedValue(0)

    const res = await request(app).get('/api/progress/overview').expect(200)

    expect(res.body.data).toEqual({
      totalVocab: 0,
      thisMonthWords: 0,
      growthRate: 0,
      avgTTR: 0,
      rank: 'A1',
      totalEssays: 0,
    })
  })

  it('LG-46 applies every remaining rank threshold at its lower boundary', async () => {
    const thresholds = [
      { totalVocab: 100, avgTTR: 0, rank: 'A2' },
      { totalVocab: 400, avgTTR: 0.6, rank: 'B2' },
      { totalVocab: 600, avgTTR: 0.65, rank: 'C1' },
      { totalVocab: 800, avgTTR: 0.7, rank: 'C2' },
    ]

    for (const threshold of thresholds) {
      Vocabulary.countDocuments
        .mockResolvedValueOnce(threshold.totalVocab)
        .mockResolvedValueOnce(0)
        .mockResolvedValueOnce(0)
      Essay.find.mockReturnValueOnce({
        distinct: vi.fn().mockResolvedValue(['essay-1']),
      })
      AIAnalysis.find.mockResolvedValueOnce([
        { scores: { vocabularyDiversity: threshold.avgTTR } },
      ])
      Essay.countDocuments.mockResolvedValueOnce(1)

      const res = await request(app).get('/api/progress/overview').expect(200)

      expect(res.body.data.rank).toBe(threshold.rank)
    }
  })

  it('LG-47 returns a six-month cumulative vocabulary chart, including empty months', async () => {
    Vocabulary.countDocuments.mockResolvedValueOnce(2)
    Vocabulary.aggregate.mockResolvedValue([
      { _id: { year: new Date().getFullYear(), month: new Date().getMonth() + 1 }, newWords: 3 },
    ])

    const res = await request(app).get('/api/progress/growth-chart').expect(200)

    expect(res.body.success).toBe(true)
    expect(res.body.data).toHaveLength(6)
    expect(res.body.data.every((point) => point)).toBe(true)
    expect(res.body.data.at(-1)).toMatchObject({ newWords: 3, cumulative: 5 })
  })

  it('LG-47 accepts a custom month count and returns an empty chart for no vocabulary', async () => {
    Vocabulary.countDocuments.mockResolvedValueOnce(0)
    Vocabulary.aggregate.mockResolvedValue([])

    const res = await request(app).get('/api/progress/growth-chart?months=3').expect(200)

    expect(res.body.data).toHaveLength(3)
    expect(res.body.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ newWords: 0, cumulative: 0 }),
      ]),
    )
  })

  it('LG-47 returns the one-month lower boundary with prior vocabulary included', async () => {
    Vocabulary.countDocuments.mockResolvedValueOnce(4)
    Vocabulary.aggregate.mockResolvedValueOnce([
      { _id: { year: new Date().getFullYear(), month: new Date().getMonth() + 1 }, newWords: 2 },
    ])

    const res = await request(app).get('/api/progress/growth-chart?months=1').expect(200)

    expect(res.body.data).toHaveLength(1)
    expect(res.body.data[0]).toMatchObject({ newWords: 2, cumulative: 6 })
  })

  it('LG-48 reports achieved and unachieved milestones from vocabulary, essays, and analysis', async () => {
    Vocabulary.countDocuments.mockResolvedValue(100)
    Essay.countDocuments.mockResolvedValue(1)
    Essay.find.mockReturnValueOnce({
      distinct: vi.fn().mockResolvedValue(['essay-1']),
    })
    AIAnalysis.find.mockResolvedValue([
      { scores: { vocabularyDiversity: 0.65, complexityIndex: 7 } },
    ])

    const res = await request(app).get('/api/progress/milestones').expect(200)

    expect(res.body.success).toBe(true)
    expect(res.body.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ title: 'First Essay Submitted', achieved: true }),
        expect.objectContaining({ title: '100 Words Milestone', achieved: true }),
        expect.objectContaining({ title: '500 Words Milestone', achieved: false }),
        expect.objectContaining({ title: 'TTR > 0.6', achieved: true }),
        expect.objectContaining({ title: 'First C1 Essay', achieved: true }),
      ]),
    )
  })

  it('LG-48 marks all milestones as unachieved when the student has no activity', async () => {
    Vocabulary.countDocuments.mockResolvedValue(0)
    Essay.countDocuments.mockResolvedValue(0)
    Essay.find.mockReturnValueOnce({
      distinct: vi.fn().mockResolvedValue([]),
    })
    AIAnalysis.find.mockResolvedValue([])

    const res = await request(app).get('/api/progress/milestones').expect(200)

    expect(res.body.data).toHaveLength(8)
    expect(res.body.data.every((milestone) => milestone.achieved === false)).toBe(true)
  })

  it('LG-48 marks upper milestones achieved exactly at their thresholds', async () => {
    Vocabulary.countDocuments.mockResolvedValueOnce(1000)
    Essay.countDocuments.mockResolvedValueOnce(10)
    Essay.find.mockReturnValueOnce({
      distinct: vi.fn().mockResolvedValue(['essay-1']),
    })
    AIAnalysis.find.mockResolvedValueOnce([
      { scores: { vocabularyDiversity: 0.7, complexityIndex: 7 } },
    ])

    const res = await request(app).get('/api/progress/milestones').expect(200)

    expect(res.body.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ title: '500 Words Milestone', achieved: true }),
        expect.objectContaining({ title: '1000 Words Milestone', achieved: true }),
        expect.objectContaining({ title: 'TTR > 0.7', achieved: true }),
        expect.objectContaining({ title: '10 Essays Written', achieved: true }),
      ]),
    )
  })

  it('LG-49 calculates a consecutive streak and reports activity today', async () => {
    const today = new Date()
    const yesterday = new Date(today)
    yesterday.setDate(today.getDate() - 1)
    ReviewEvent.find.mockReturnValue({
      select: vi.fn().mockReturnThis(),
      lean: vi.fn().mockResolvedValue([
        { reviewedAt: yesterday },
        { reviewedAt: today },
      ]),
    })
    DailyQuest.find.mockReturnValue({
      select: vi.fn().mockReturnThis(),
      lean: vi.fn().mockResolvedValue([]),
    })

    const res = await request(app).get('/api/progress/streak').expect(200)

    expect(res.body).toEqual({
      success: true,
      data: expect.objectContaining({ streakDays: 2, hasActivityToday: true }),
    })
  })

  it('LG-49 returns zero streak at the no-activity boundary', async () => {
    ReviewEvent.find.mockReturnValue({
      select: vi.fn().mockReturnThis(),
      lean: vi.fn().mockResolvedValue([]),
    })
    DailyQuest.find.mockReturnValue({
      select: vi.fn().mockReturnThis(),
      lean: vi.fn().mockResolvedValue([]),
    })

    const res = await request(app).get('/api/progress/streak').expect(200)

    expect(res.body).toEqual({
      success: true,
      data: expect.objectContaining({ streakDays: 0, hasActivityToday: false }),
    })
  })

  it('LG-49 returns zero when the most recent activity is older than yesterday', async () => {
    const staleActivity = new Date()
    staleActivity.setDate(staleActivity.getDate() - 2)
    ReviewEvent.find.mockReturnValue({
      select: vi.fn().mockReturnThis(),
      lean: vi.fn().mockResolvedValue([{ reviewedAt: staleActivity }]),
    })
    DailyQuest.find.mockReturnValue({
      select: vi.fn().mockReturnThis(),
      lean: vi.fn().mockResolvedValue([]),
    })

    const res = await request(app).get('/api/progress/streak').expect(200)

    expect(res.body).toEqual({
      success: true,
      data: expect.objectContaining({ streakDays: 0, hasActivityToday: false }),
    })
  })

  it('LEARN-05 counts completed LearningSession in streak', async () => {
    const today = new Date()
    ReviewEvent.find.mockReturnValue({
      select: vi.fn().mockReturnThis(),
      lean: vi.fn().mockResolvedValue([]),
    })
    DailyQuest.find.mockReturnValue({
      select: vi.fn().mockReturnThis(),
      lean: vi.fn().mockResolvedValue([]),
    })
    LearningSession.find.mockReturnValue({
      select: vi.fn().mockReturnThis(),
      lean: vi.fn().mockResolvedValue([{ completedAt: today }]),
    })
    Essay.find.mockReturnValue({
      select: vi.fn().mockReturnThis(),
      lean: vi.fn().mockResolvedValue([]),
    })

    const res = await request(app).get('/api/progress/streak').expect(200)

    expect(res.body).toEqual({
      success: true,
      data: expect.objectContaining({ streakDays: 1, hasActivityToday: true }),
    })
  })

  it('LEARN-05 counts submitted Essay in streak', async () => {
    const today = new Date()
    const yesterday = new Date(today)
    yesterday.setDate(today.getDate() - 1)

    ReviewEvent.find.mockReturnValue({
      select: vi.fn().mockReturnThis(),
      lean: vi.fn().mockResolvedValue([]),
    })
    DailyQuest.find.mockReturnValue({
      select: vi.fn().mockReturnThis(),
      lean: vi.fn().mockResolvedValue([]),
    })
    LearningSession.find.mockReturnValue({
      select: vi.fn().mockReturnThis(),
      lean: vi.fn().mockResolvedValue([{ completedAt: yesterday }]),
    })
    Essay.find.mockReturnValue({
      select: vi.fn().mockReturnThis(),
      lean: vi.fn().mockResolvedValue([{ submittedAt: today }]),
    })

    const res = await request(app).get('/api/progress/streak').expect(200)

    expect(res.body).toEqual({
      success: true,
      data: expect.objectContaining({ streakDays: 2, hasActivityToday: true }),
    })
  })

  it('LEARN-05 queries essays with status: { $ne: "draft" } and non-null submittedAt', async () => {
    ReviewEvent.find.mockReturnValue({
      select: vi.fn().mockReturnThis(),
      lean: vi.fn().mockResolvedValue([]),
    })
    DailyQuest.find.mockReturnValue({
      select: vi.fn().mockReturnThis(),
      lean: vi.fn().mockResolvedValue([]),
    })
    LearningSession.find.mockReturnValue({
      select: vi.fn().mockReturnThis(),
      lean: vi.fn().mockResolvedValue([]),
    })
    Essay.find.mockReturnValue({
      select: vi.fn().mockReturnThis(),
      lean: vi.fn().mockResolvedValue([]),
    })

    await request(app).get('/api/progress/streak').expect(200)

    expect(Essay.find).toHaveBeenCalledWith(
      expect.objectContaining({
        status: { $ne: 'draft' },
        submittedAt: expect.anything(),
      }),
    )
    expect(LearningSession.find).toHaveBeenCalledWith(
      expect.objectContaining({
        completedAt: expect.anything(),
      }),
    )
  })
})

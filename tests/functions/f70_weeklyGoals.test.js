import { vi, describe, it, expect, beforeEach } from 'vitest'
import { createMockContext } from './testHelper.js'

vi.mock('../../src/config/db.js', () => ({
  default: vi.fn().mockImplementation(() => Promise.resolve()),
}))

vi.mock('../../src/models/WeeklyGoal.js', () => ({
  default: {
    findOne: vi.fn(),
    create: vi.fn(),
  },
}))

vi.mock('../../src/models/Vocabulary.js', () => ({
  default: {
    find: vi.fn(),
    countDocuments: vi.fn(),
  },
}))

vi.mock('../../src/models/WordUsageEvidence.js', () => ({
  default: {
    distinct: vi.fn(),
    find: vi.fn(),
  },
}))

vi.mock('../../src/models/Essay.js', () => ({
  default: {
    find: vi.fn(),
    countDocuments: vi.fn(),
  },
}))

vi.mock('../../src/models/AIAnalysis.js', () => ({
  default: {
    find: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue([]),
      }),
    }),
  },
}))

import WeeklyGoal from '../../src/models/WeeklyGoal.js'
import Vocabulary from '../../src/models/Vocabulary.js'
import WordUsageEvidence from '../../src/models/WordUsageEvidence.js'
import Essay from '../../src/models/Essay.js'
import AIAnalysis from '../../src/models/AIAnalysis.js'
import { getCurrentGoals, countLearnedWords } from '../../src/controllers/goals.controller.js'

describe('LEARN-04: Weekly Goals "New Words" calculation (countLearnedWords)', () => {
  const studentId = '507f1f77bcf86cd799439011'
  const weekStart = new Date('2026-11-09T00:00:00.000Z')
  const weekEnd = new Date('2026-11-15T23:59:59.999Z')

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('UTCID01 (B): should return 0 when starting session adds target words but student has not reviewed or written anything', async () => {
    // 5 words inserted on session start with reviewCount: 0
    Vocabulary.find.mockReturnValue({
      select: vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue([
          { word: 'ephemeral', reviewCount: 0 },
          { word: 'meticulous', reviewCount: 0 },
          { word: 'resilient', reviewCount: 0 },
          { word: 'pragmatic', reviewCount: 0 },
          { word: 'lucid', reviewCount: 0 },
        ]),
      }),
    })
    // No usage evidence
    WordUsageEvidence.distinct.mockResolvedValue([])

    const count = await countLearnedWords(studentId, weekStart, weekEnd)

    expect(count).toBe(0)
    expect(Vocabulary.find).toHaveBeenCalledWith({
      student: studentId,
      createdAt: { $gte: weekStart, $lte: weekEnd },
    })
  })

  it('UTCID02 (N): should count words that have reviewCount > 0 from flashcard / SRS reviews', async () => {
    // 3 words reviewed, 2 words unreviewed
    Vocabulary.find.mockReturnValue({
      select: vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue([
          { word: 'ephemeral', reviewCount: 2 },
          { word: 'meticulous', reviewCount: 1 },
          { word: 'resilient', reviewCount: 3 },
          { word: 'pragmatic', reviewCount: 0 },
          { word: 'lucid', reviewCount: 0 },
        ]),
      }),
    })
    WordUsageEvidence.distinct.mockResolvedValue([])

    const count = await countLearnedWords(studentId, weekStart, weekEnd)

    expect(count).toBe(3)
  })

  it('UTCID03 (N): should count unreviewed words that have verified WordUsageEvidence in essays', async () => {
    Vocabulary.find.mockReturnValue({
      select: vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue([
          { word: 'ephemeral', reviewCount: 0 },
          { word: 'meticulous', reviewCount: 0 },
          { word: 'resilient', reviewCount: 0 },
        ]),
      }),
    })
    // 2 of the unreviewed words were used in essay writing
    WordUsageEvidence.distinct
      .mockResolvedValueOnce(['ephemeral', 'resilient']) // for unreviewed candidate list
      .mockResolvedValueOnce([]) // this week usage query

    const count = await countLearnedWords(studentId, weekStart, weekEnd)

    expect(count).toBe(2)
  })

  it('UTCID04 (N): should deduplicate when a word has both reviewCount > 0 and WordUsageEvidence', async () => {
    Vocabulary.find.mockReturnValue({
      select: vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue([
          { word: 'ephemeral', reviewCount: 1 },
          { word: 'meticulous', reviewCount: 0 },
        ]),
      }),
    })
    WordUsageEvidence.distinct
      .mockResolvedValueOnce(['meticulous'])
      .mockResolvedValueOnce(['ephemeral']) // also used in writing this week

    const count = await countLearnedWords(studentId, weekStart, weekEnd)

    expect(count).toBe(2)
  })

  it('UTCID05 (N): should include words with WordUsageEvidence produced this week even if Vocabulary was created earlier', async () => {
    Vocabulary.find.mockReturnValue({
      select: vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue([]),
      }),
    })
    WordUsageEvidence.distinct
      .mockResolvedValueOnce(['eloquent', 'ubiquitous'])

    const count = await countLearnedWords(studentId, weekStart, weekEnd)

    expect(count).toBe(2)
  })

  it('UTCID06 (N): getCurrentGoals should set "New Words" current count using countLearnedWords', async () => {
    const saveMock = vi.fn().mockResolvedValue(true)
    const existingGoal = {
      _id: 'goal_1',
      student: studentId,
      weekStart,
      weekEnd,
      goals: [
        { label: 'New Words', target: 20, current: 0, toObject: () => ({ label: 'New Words', target: 20, current: 0 }) },
        { label: 'Essays Written', target: 3, current: 0, toObject: () => ({ label: 'Essays Written', target: 3, current: 0 }) },
      ],
      save: saveMock,
    }
    WeeklyGoal.findOne.mockResolvedValue(existingGoal)

    // 2 words genuinely learned
    Vocabulary.find.mockReturnValue({
      select: vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue([
          { word: 'learned_1', reviewCount: 1 },
          { word: 'learned_2', reviewCount: 2 },
          { word: 'unstudied_3', reviewCount: 0 },
        ]),
      }),
    })
    WordUsageEvidence.distinct.mockResolvedValue([])

    // 1 essay submitted
    Essay.find.mockResolvedValue([
      { _id: 'e1', wordCount: 350 },
    ])

    const { req, res, next } = createMockContext({
      user: { _id: studentId, role: 'student' },
    })

    await getCurrentGoals(req, res, next)

    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.data.success).toBe(true)
    const newWordsGoal = res.data.data.goals.find((g) => g.label === 'New Words')
    expect(newWordsGoal.current).toBe(2) // 2 learned, unstudied excluded
    expect(saveMock).toHaveBeenCalled()
  })

  it('UTCID07 (LEARN-20): should compute Complexity Score average from AI analyses and use student timezone', async () => {
    const saveMock = vi.fn().mockResolvedValue(true)
    const existingGoal = {
      _id: 'goal_2',
      student: studentId,
      weekStart,
      weekEnd,
      goals: [
        { label: 'Complexity Score', target: 8, current: 0, toObject: () => ({ label: 'Complexity Score', target: 8, current: 0 }) },
      ],
      save: saveMock,
    }
    WeeklyGoal.findOne.mockResolvedValue(existingGoal)

    Vocabulary.find.mockReturnValue({
      select: vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue([]),
      }),
    })
    WordUsageEvidence.distinct.mockResolvedValue([])

    // 2 essays submitted this week
    Essay.find.mockResolvedValue([
      { _id: 'e1', wordCount: 300 },
      { _id: 'e2', wordCount: 400 },
    ])

    // AI analysis with complexityIndex scores: 7.5 and 8.5 -> average 8.0
    AIAnalysis.find.mockReturnValue({
      select: vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue([
          { essay: 'e1', scores: { complexityIndex: 7.5 } },
          { essay: 'e2', scores: { complexityIndex: 8.5 } },
        ]),
      }),
    })

    const { req, res, next } = createMockContext({
      user: {
        _id: studentId,
        role: 'student',
        learningProfile: { timezone: 'Asia/Tokyo' },
      },
    })

    await getCurrentGoals(req, res, next)

    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.data.success).toBe(true)
    const complexityGoal = res.data.data.goals.find((g) => g.label === 'Complexity Score')
    expect(complexityGoal.current).toBe(8)
    expect(saveMock).toHaveBeenCalled()
  })
})


import { beforeEach, describe, expect, it, vi } from 'vitest'
import User from '../src/models/User.js'
import Class from '../src/models/Class.js'
import Assignment from '../src/models/Assignment.js'
import Essay from '../src/models/Essay.js'
import AIAnalysis from '../src/models/AIAnalysis.js'
import Vocabulary from '../src/models/Vocabulary.js'
import { getStudentAnalytics } from '../src/controllers/teacher.controller.js'

vi.mock('../src/models/User.js', () => ({ default: { findById: vi.fn() } }))
vi.mock('../src/models/Class.js', () => ({ default: { find: vi.fn() } }))
vi.mock('../src/models/Assignment.js', () => ({ default: { distinct: vi.fn() } }))
vi.mock('../src/models/Essay.js', () => ({ default: { find: vi.fn() } }))
vi.mock('../src/models/AIAnalysis.js', () => ({ default: { find: vi.fn() } }))
vi.mock('../src/models/Vocabulary.js', () => ({ default: { find: vi.fn() } }))
vi.mock('../src/services/masteryView.service.js', () => ({
  getMasteredWords: vi.fn(),
  effectiveMastery: vi.fn(),
  withEffectiveMastery: vi.fn(),
}))
vi.mock('../src/services/studentStatus.service.js', () => ({
  classifyStudents: vi.fn(),
  classifyStudentStatus: vi.fn(),
}))
vi.mock('../src/models/Alert.js', () => ({ default: { find: vi.fn() } }))

import { getMasteredWords } from '../src/services/masteryView.service.js'
import { classifyStudentStatus } from '../src/services/studentStatus.service.js'

const request = () => ({
  user: { _id: 'teacher1', role: 'teacher' },
  params: { id: 'student1' },
})
const response = () => ({ status: vi.fn().mockReturnThis(), json: vi.fn() })

function selectQuery(value) {
  return { select: vi.fn().mockResolvedValue(value) }
}

function vocabularyQuery(rows) {
  return { select: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue(rows) }) }
}

function essayQuery(rows) {
  const query = { sort: vi.fn().mockResolvedValue(rows) }
  return query
}

describe('TEACH-03 student analytics essay scope', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    User.findById.mockReturnValue(selectQuery({ _id: 'student1', name: 'An', email: 'an@example.com' }))
    getMasteredWords.mockResolvedValue(new Set())
    classifyStudentStatus.mockResolvedValue({ status: 'stagnating', signals: [] })
  })

  it('denies analytics when the teacher has no common class', async () => {
    Class.find.mockResolvedValue([])
    const next = vi.fn()

    await getStudentAnalytics(request(), response(), next)

    expect(next).toHaveBeenCalledOnce()
    expect(next.mock.calls[0][0].statusCode).toBe(403)
  })

  it('includes only essays from the teacher classes in analytics', async () => {
    Class.find.mockResolvedValue([{ _id: 'classOld', name: 'Old class' }])
    Assignment.distinct.mockResolvedValue(['assignmentOld'])
    Essay.find.mockReturnValue(essayQuery([{
      _id: 'essayOld',
      title: 'Old essay',
      createdAt: new Date('2026-01-01'),
      wordCount: 100,
    }]))
    AIAnalysis.find.mockResolvedValue([])
    Vocabulary.find.mockReturnValue(vocabularyQuery([]))
    const res = response()

    await getStudentAnalytics(request(), res, vi.fn())

    expect(Essay.find).toHaveBeenCalledWith({
      student: 'student1',
      status: { $ne: 'draft' },
      $or: [
        { class: { $in: ['classOld'] } },
        { assignment: { $in: ['assignmentOld'] } },
      ],
    })
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        metrics: expect.objectContaining({ totalEssays: 1 }),
        essayHistory: [expect.objectContaining({ _id: 'essayOld' })],
      }),
    }))
  })
})

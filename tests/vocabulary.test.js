import { vi, describe, it, expect } from 'vitest'

// Helper for mongoose query builder chain
const mockQuery = (val) => {
  const q = {
    select: vi.fn().mockImplementation(() => q),
    sort: vi.fn().mockImplementation(() => q),
    skip: vi.fn().mockImplementation(() => q),
    limit: vi.fn().mockImplementation(() => q),
    lean: vi.fn().mockImplementation(() => q),
    then: (resolve) => resolve(val),
    catch: () => {}
  }
  return q
}

// Mock db connection
vi.mock('../src/config/db.js', () => ({
  default: vi.fn().mockImplementation(() => Promise.resolve())
}))

// Mock models
vi.mock('../src/models/Vocabulary.js', () => ({
  default: {
    find: vi.fn(),
    findOne: vi.fn(),
    create: vi.fn(),
    updateOne: vi.fn().mockResolvedValue({ modifiedCount: 1 }),
    countDocuments: vi.fn(),
    distinct: vi.fn(),
  }
}))

// Mock protect middleware to inject a mock req.user
vi.mock('../src/middleware/auth.middleware.js', () => ({
  optionalAuth: (req, res, next) => next(),
  protect: (req, res, next) => {
    req.user = { _id: 'mock_student_id', role: 'student', name: 'Mock Student' }
    next()
  },
  authorize: () => (req, res, next) => {
    next()
  }
}))

// Mock AI service
vi.mock('../src/services/ai.service.js', () => ({
  enrichWordsList: vi.fn().mockResolvedValue([
    {
      ipa: '/tɛst/',
      partOfSpeech: 'noun',
      definition: 'A procedure intended to establish the quality, performance, or reliability of something.',
      exampleSentence: 'This is a test sentence.',
      synonyms: ['trial', 'experiment'],
      antonyms: []
    }
  ])
}))

vi.mock('../src/models/WordUsageEvidence.js', () => ({
  default: { aggregate: vi.fn().mockResolvedValue([]) },
}))

import request from 'supertest'
import app from '../src/index.js'
import Vocabulary from '../src/models/Vocabulary.js'

describe('Vocabulary API - Add to Study List', () => {
  it('should successfully add a new word to the study list with AI enrichment', async () => {
    // 1. Mock findOne to return null (word doesn't exist yet in user's list or system)
    Vocabulary.findOne
      .mockReturnValueOnce(mockQuery(null)) // student library check
      .mockReturnValueOnce(mockQuery(null)) // system-wide enrichment check

    // 2. Mock create
    Vocabulary.create.mockResolvedValue({
      _id: 'mock_word_id',
      word: 'test',
      student: 'mock_student_id',
      ipa: '/tɛst/',
      definition: 'A procedure...',
      synonyms: ['trial', 'experiment'],
      antonyms: []
    })

    const res = await request(app)
      .post('/api/vocabulary')
      .send({ word: 'test' })
      .expect(201)

    expect(res.body.success).toBe(true)
    expect(res.body.data.word).toBe('test')
  })

  it('enriches the word after responding instead of blocking the request', async () => {
    Vocabulary.findOne
      .mockReturnValueOnce(mockQuery(null))
      .mockReturnValueOnce(mockQuery(null))
    Vocabulary.create.mockImplementation(async (doc) => ({ _id: 'mock_word_id', ...doc }))

    const res = await request(app)
      .post('/api/vocabulary')
      .send({ word: 'test' })
      .expect(201)

    expect(res.body.data.enrichmentStatus).toBe('pending')

    await new Promise((resolve) => setImmediate(resolve))

    expect(Vocabulary.updateOne).toHaveBeenCalledWith(
      { _id: 'mock_word_id' },
      {
        $set: expect.objectContaining({
          ipa: '/tɛst/',
          definition: expect.stringContaining('procedure'),
          enrichmentStatus: 'done',
        }),
      },
    )
  })

  it('should ignore a client-supplied masteryLevel and always create the word as new', async () => {
    Vocabulary.findOne
      .mockReturnValueOnce(mockQuery(null))
      .mockReturnValueOnce(mockQuery(null))

    Vocabulary.create.mockImplementation(async (doc) => ({ _id: 'mock_word_id', ...doc }))

    const res = await request(app)
      .post('/api/vocabulary')
      .send({ word: 'genuine', masteryLevel: 'mastered' })
      .expect(201)

    expect(Vocabulary.create.mock.lastCall[0].masteryLevel).toBe('new')
    expect(res.body.data.masteryLevel).toBe('new')
  })

  it('should return 400 if the word already exists in the student library', async () => {
    Vocabulary.findOne.mockReturnValueOnce(mockQuery({ _id: 'existing_id', word: 'test' }))

    const res = await request(app)
      .post('/api/vocabulary')
      .send({ word: 'test' })
      .expect(400)

    expect(res.body.success).toBe(false)
    expect(res.body.error).toContain('already exists')
  })
})

describe('GET /api/vocabulary - Paginated Vocabulary Library', () => {
  it('should return paginated vocabulary words with metadata, themes and dueCount', async () => {
    const mockWords = [
      { _id: 'word1', word: 'articulate', category: 'academic', theme: 'Language' },
      { _id: 'word2', word: 'benchmark', category: 'business', theme: 'Tech' }
    ]

    Vocabulary.find.mockReturnValue(mockQuery(mockWords))
    Vocabulary.countDocuments
      .mockResolvedValueOnce(50) // total matching
      .mockResolvedValueOnce(5)  // due count
    Vocabulary.distinct.mockResolvedValue(['Language', 'Tech', 'Environment'])

    const res = await request(app)
      .get('/api/vocabulary?page=2&limit=24&category=academic&search=articulate')
      .expect(200)

    expect(res.body.success).toBe(true)
    expect(res.body.count).toBe(2)
    expect(res.body.total).toBe(50)
    expect(res.body.page).toBe(2)
    expect(res.body.pages).toBe(3)
    expect(res.body.limit).toBe(24)
    expect(res.body.themes).toEqual(['Language', 'Tech', 'Environment'])
    expect(res.body.dueCount).toBe(5)
    expect(res.body.data).toHaveLength(2)
  })

  it('rejects an invalid page instead of failing the query', async () => {
    await request(app).get('/api/vocabulary?page=0').expect(400)
    await request(app).get('/api/vocabulary?limit=abc').expect(400)
  })

  it('treats regex characters in the search term as plain text', async () => {
    Vocabulary.find.mockReturnValue(mockQuery([]))
    Vocabulary.countDocuments.mockResolvedValue(0)
    Vocabulary.distinct.mockResolvedValue([])

    await request(app).get('/api/vocabulary?search=%5B').expect(200)

    const findArg = Vocabulary.find.mock.calls.at(-1)[0]
    expect(findArg.$and[0].word.$regex).toBe('\\[')
  })
})

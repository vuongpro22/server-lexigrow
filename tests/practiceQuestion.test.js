import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/models/AILog.js', () => ({
  default: {
    create: vi.fn().mockResolvedValue(true),
  },
}))

vi.mock('../src/models/LearningSession.js', () => ({
  default: {
    updateOne: vi.fn().mockResolvedValue({ acknowledged: true, modifiedCount: 1 }),
  },
}))

vi.mock('../src/services/aiRelayClient.service.js', () => ({
  completeThroughRelay: vi.fn(),
}))

import { completeThroughRelay } from '../src/services/aiRelayClient.service.js'
import { generatePracticeQuestions } from '../src/services/practiceQuestion.service.js'
import { getPracticeQuestionsForSession } from '../src/controllers/practiceQuestion.controller.js'
import LearningSession from '../src/models/LearningSession.js'

describe('Practice Question Generator Service', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('generates questions via AI and guarantees blanks are masked properly', async () => {
    // Simulate AI returning questions with and without exact blank
    completeThroughRelay.mockResolvedValueOnce({
      text: JSON.stringify({
        questions: [
          {
            id: 'ai_1',
            word: 'grocery',
            type: 'fill_in_blank',
            title: 'Choose the correct word for the blank:',
            sentence: 'I went to buy some groceries for dinner.', // Notice: AI returned unmasked sentence with plural
            options: ['grocery', 'commute', 'routine', 'airport'],
            correctAnswer: 'grocery',
            explanation: 'Grocery refers to food and supplies.',
          },
          {
            id: 'ai_2',
            word: 'commute',
            type: 'multiple_choice',
            title: 'What does "commute" mean?',
            sentence: 'Her commute takes 30 minutes.',
            options: ['Traveling between home and work', 'Exercising', 'Cooking dinner', 'Sleeping'],
            correctAnswer: 'Traveling between home and work',
            explanation: 'Commute means daily work travel.',
          },
          {
            id: 'ai_3',
            word: 'grocery',
            type: 'multiple_choice',
            title: 'What does grocery mean?',
            sentence: 'The grocery store sells fresh bread.',
            options: ['Food and household items', 'Travel plans', 'Exercise equipment', 'School books'],
            correctAnswer: 'Food and household items',
          },
          {
            id: 'ai_4',
            word: 'commute',
            type: 'fill_in_blank',
            title: 'Choose the correct word for the blank:',
            sentence: 'She will _______ to work by train.',
            options: ['commute', 'grocery', 'routine', 'airport'],
            correctAnswer: 'commute',
          },
        ],
      }),
      usage: { totalTokens: 150 },
    })

    const mockSession = {
      _id: '507f1f77bcf86cd799439011',
      theme: 'Daily Life',
      level: 'A2',
      targetWords: [
        { word: 'grocery', partOfSpeech: 'noun', definitionVi: 'đồ tạp hóa' },
        { word: 'commute', partOfSpeech: 'verb', definitionVi: 'đi làm hàng ngày' },
      ],
      practiceQuestions: [],
    }

    const result = await generatePracticeQuestions(mockSession, { bypassCache: true })

    expect(result.source).toBe('ai')
    expect(result.questions).toHaveLength(4)

    // Verify auto-masking caught 'groceries' and replaced with '_______'
    const groceryFib = result.questions.find((q) => q.word === 'grocery')
    expect(groceryFib.sentence).toContain('_______')
    expect(groceryFib.sentence.toLowerCase()).not.toContain('groceries')
    expect(groceryFib.options).toContain('grocery')
  })

  it('falls back when AI returns a fabricated answer or wrong question count', async () => {
    completeThroughRelay.mockResolvedValueOnce({
      text: JSON.stringify({ questions: [{
        word: 'grocery', type: 'fill_in_blank', title: 'Choose', sentence: 'I bought groceries.',
        options: ['grocery', 'commute', 'routine', 'airport'], correctAnswer: 'routine',
      }] }),
      usage: { totalTokens: 10 },
    })
    const result = await generatePracticeQuestions({
      _id: '507f1f77bcf86cd799439014',
      theme: 'Daily Life',
      level: 'A2',
      targetWords: [{ word: 'grocery' }],
      practiceQuestions: [],
    }, { bypassCache: true })
    expect(result.source).toBe('fallback')
  })

  it('generates fallback questions when AI is offline, ensuring blanks and 4 options', async () => {
    // Simulate AI failure
    completeThroughRelay.mockRejectedValueOnce(new Error('AI relay offline'))

    const mockSession = {
      _id: '507f1f77bcf86cd799439012',
      theme: 'Daily Life',
      level: 'A2',
      targetWords: [
        {
          word: 'grocery',
          partOfSpeech: 'noun',
          definitionVi: 'thực phẩm, đồ tạp hóa',
          exampleSentences: ['I need to buy some groceries for dinner.'],
        },
        {
          word: 'routine',
          partOfSpeech: 'noun',
          definitionVi: 'thói quen hàng ngày',
          exampleSentences: ['My daily routine starts early.'],
        },
      ],
      practiceQuestions: [],
    }

    const result = await generatePracticeQuestions(mockSession)

    expect(result.source).toBe('fallback')
    expect(result.questions.length).toBeGreaterThanOrEqual(4)

    const groceryFib = result.questions.find(
      (q) => q.word === 'grocery' && q.type === 'fill_in_blank',
    )
    expect(groceryFib).toBeDefined()
    expect(groceryFib.sentence).toContain('_______')
    expect(groceryFib.sentence.toLowerCase()).not.toContain('groceries')
    expect(groceryFib.options).toHaveLength(4)
    expect(groceryFib.options).toContain('grocery')
  })

  it('preserves cached questions when bypassCache is false', async () => {
    const cachedQuestions = [
      {
        id: 'cached_1',
        word: 'commute',
        type: 'multiple_choice',
        title: 'Cached Question',
        options: ['A', 'B', 'C', 'D'],
        correctAnswer: 'A',
      },
    ]

    const mockSession = {
      _id: '507f1f77bcf86cd799439013',
      targetWords: [{ word: 'commute' }],
      practiceQuestions: cachedQuestions,
    }

    const result = await generatePracticeQuestions(mockSession, {
      bypassCache: false,
    })
    expect(result.source).toBe('cache')
    expect(result.questions).toEqual(cachedQuestions)
  })

  it('[LEARN-14 / ST-09] getPracticeQuestionsForSession strips correctAnswer and explanation from response', async () => {
    const mockSession = {
      _id: '507f1f77bcf86cd799439014',
      targetWords: [{ word: 'commute' }],
      practiceQuestions: [
        {
          id: 'q1',
          word: 'commute',
          type: 'multiple_choice',
          title: 'Title',
          sentence: 'Sentence',
          options: ['A', 'B'],
          correctAnswer: 'A',
          explanation: 'Secret Explanation',
        },
      ],
    }
    LearningSession.findOne = vi.fn().mockResolvedValue(mockSession)

    const req = {
      params: { id: '507f1f77bcf86cd799439014' },
      user: { _id: 'student_1' },
      query: {},
    }
    const res = {
      json: vi.fn(),
    }
    const next = vi.fn()

    await getPracticeQuestionsForSession(req, res, next)

    expect(res.json).toHaveBeenCalled()
    const data = res.json.mock.calls[0][0].data
    expect(data.questions).toHaveLength(1)
    expect(data.questions[0].correctAnswer).toBeUndefined()
    expect(data.questions[0].explanation).toBeUndefined()
    expect(data.questions[0].id).toBe('q1')
    expect(data.questions[0].word).toBe('commute')
  })

  it('[LEARN-15] normalizes uppercase and punctuated words from AI and maps wordId correctly', async () => {
    completeThroughRelay.mockResolvedValueOnce({
      text: JSON.stringify({
        questions: [
          {
            id: 'ai_upper_1',
            word: 'GROCERY!',
            type: 'multiple_choice',
            title: 'What does "grocery" mean?',
            sentence: 'I went to buy some grocery items.',
            options: ['Food items', 'Books', 'Cars', 'Tickets'],
            correctAnswer: 'Food items',
            explanation: 'Grocery means food.',
          },
          {
            id: 'ai_upper_2',
            word: 'Grocery',
            type: 'fill_in_blank',
            title: 'Choose the correct word for the blank:',
            sentence: 'I bought _______ at the local store.',
            options: ['grocery', 'commute', 'routine', 'airport'],
            correctAnswer: 'grocery',
            explanation: 'Grocery is correct.',
          },
        ],
      }),
      usage: { totalTokens: 100 },
    })

    const mockSession = {
      _id: '507f1f77bcf86cd799439015',
      theme: 'Shopping',
      level: 'A2',
      targetWords: [
        { wordId: 'word_grocery_id', word: 'grocery', partOfSpeech: 'noun', definitionVi: 'đồ tạp hóa' },
      ],
      practiceQuestions: [],
    }

    const result = await generatePracticeQuestions(mockSession, { bypassCache: true })

    expect(result.source).toBe('ai')
    expect(result.questions).toHaveLength(2)
    expect(result.questions[0].word).toBe('grocery')
    expect(result.questions[0].wordId).toBe('word_grocery_id')
    expect(result.questions[1].word).toBe('grocery')
    expect(result.questions[1].wordId).toBe('word_grocery_id')
  })
})

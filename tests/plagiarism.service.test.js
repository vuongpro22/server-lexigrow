import { vi, describe, it, expect, beforeEach } from 'vitest'
import { checkCrossStudentPlagiarism } from '../src/services/plagiarism.service.js'
import Essay from '../src/models/Essay.js'

// Mock Essay model
vi.mock('../src/models/Essay.js', () => {
  const mockFind = vi.fn()
  return {
    default: {
      find: mockFind
    }
  }
})

vi.mock('groq-sdk', () => {
  return {
    default: class MockGroq {
      constructor() {
        this.chat = {
          completions: {
            create: vi.fn().mockImplementation(async ({ messages, response_format }) => {
              const sysMsg = messages.find(m => m.role === 'system')?.content || ''
              if (response_format?.type === 'json_object' || sysMsg.includes('spellcheck')) {
                return {
                  choices: [{
                    message: {
                      content: JSON.stringify({
                        errors: [
                          {
                            error: 'he go',
                            correction: 'he went',
                            explanation: 'Subject-verb agreement'
                          }
                        ]
                      })
                    }
                  }],
                  usage: { total_tokens: 10 }
                }
              }
              return {
                choices: [{
                  message: {
                    content: 'He went to school yesterday.'
                  }
                }],
                usage: { total_tokens: 10 }
              }
            })
          }
        }
      }
    }
  }
})

describe('Plagiarism Service - 3-Grams Jaccard Similarity', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should flag plagiarism if Jaccard similarity of 3-grams is >= 0.25', async () => {
    const essayText = 'In this essay, I will delve into the tapestry of human history. The beacon of hope shines bright in the cradle of civilization.'
    
    // Matched essay with slight changes
    const matchedEssayContent = 'In this essay, I will delve into the tapestry of human history. The beacon of hope shines bright in the cradle of civilization and love.'
    
    const mockEssays = [
      {
        _id: 'matched_essay_id',
        title: 'Matched Essay',
        content: matchedEssayContent
      },
      {
        _id: 'different_essay_id',
        title: 'Different Essay',
        content: 'This is a completely different text talking about technology and algorithms in science.'
      }
    ]

    const mockSelect = vi.fn().mockResolvedValue(mockEssays)
    Essay.find.mockReturnValue({
      select: mockSelect
    })

    const result = await checkCrossStudentPlagiarism('new_essay_id', essayText)

    expect(Essay.find).toHaveBeenCalledWith({
      _id: { $ne: 'new_essay_id' },
      status: { $in: ['submitted', 'reviewed'] }
    })
    expect(result.isPlagiarized).toBe(true)
    expect(result.similarityScore).toBeGreaterThanOrEqual(0.25)
    expect(result.matchedEssay).toBe('matched_essay_id')
  })

  it('excludes the same student from peer-plagiarism comparisons', async () => {
    const essayText = 'A learner should practice writing every day to improve their communication skills.'
    const mockEssays = [{ _id: 'peer', title: 'Peer', content: essayText }]
    const mockSelect = vi.fn().mockResolvedValue(mockEssays)
    Essay.find.mockReturnValue({ select: mockSelect })
    await checkCrossStudentPlagiarism('new_essay_id', essayText, 'student_1')
    expect(Essay.find).toHaveBeenCalledWith({
      _id: { $ne: 'new_essay_id' },
      student: { $exists: true, $ne: 'student_1' },
      status: { $in: ['submitted', 'reviewed'] },
    })
  })

  it('should not flag plagiarism if texts are completely different', async () => {
    const essayText = 'In this essay, I will discuss the benefits of learning foreign languages in the modern globalized world.'
    
    const mockEssays = [
      {
        _id: 'other_essay_id',
        title: 'Other Essay',
        content: 'This is a completely different text talking about biology, cells, photosynthesis and plant growth.'
      }
    ]

    const mockSelect = vi.fn().mockResolvedValue(mockEssays)
    Essay.find.mockReturnValue({
      select: mockSelect
    })

    const result = await checkCrossStudentPlagiarism('new_essay_id', essayText)

    expect(result.isPlagiarized).toBe(false)
    expect(result.similarityScore).toBeLessThan(0.25)
    expect(result.matchedEssay).toBeNull()
  })
})

// Mock Config model
vi.mock('../src/models/Config.js', () => {
  return {
    default: {
      findOne: vi.fn().mockResolvedValue({ value: 'gsk_valid_mock_key_for_testing' })
    }
  }
})

// Mock AILog model
vi.mock('../src/models/AILog.js', () => {
  return {
    default: {
      create: vi.fn().mockResolvedValue({})
    }
  }
})

// Mock groq-sdk
vi.mock('groq-sdk', () => {
  const mockCreate = vi.fn().mockImplementation(async (options) => {
    if (options.response_format && options.response_format.type === 'json_object') {
      return {
        choices: [
          {
            message: {
              content: JSON.stringify({
                errors: [
                  {
                    error: 'he go',
                    correction: 'he went',
                    explanation: 'Should use past tense.'
                  }
                ]
              })
            }
          }
        ],
        usage: { prompt_tokens: 10, completion_tokens: 20 }
      }
    }
    return {
      choices: [
        {
          message: {
            content: 'He went to school yesterday.'
          }
        }
      ],
      usage: { prompt_tokens: 10, completion_tokens: 20 }
    }
  })

  return {
    default: class MockGroq {
      constructor() {
        this.chat = {
          completions: {
            create: mockCreate
          }
        }
      }
    }
  }
})

describe('AI Helper Service', () => {
  it('should process spellcheck and return error objects', async () => {
    // Dynamically import to ensure mocks are applied
    const { runAIHelperService } = await import('../src/services/ai.service.js')
    const text = 'he go to school yesterday'
    const result = await runAIHelperService(text, 'spellcheck')
    expect(result).toBeInstanceOf(Array)
    expect(result[0].error).toBe('he go')
    expect(result[0].correction).toBe('he went')
  })

  it('should process improve and return polished text', async () => {
    const { runAIHelperService } = await import('../src/services/ai.service.js')
    const text = 'he go to school yesterday'
    const result = await runAIHelperService(text, 'improve')
    expect(result).toBe('He went to school yesterday.')
  })
})

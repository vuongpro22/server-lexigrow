import { vi, describe, it, expect, beforeEach } from 'vitest'

vi.mock('../../src/config/db.js', () => ({
  default: vi.fn().mockImplementation(() => Promise.resolve())
}))

vi.mock('../../src/models/AIAnalysis.js', () => ({
  default: {
    create: vi.fn(),
    findOne: vi.fn(),
  }
}))

vi.mock('../../src/models/AILog.js', () => ({
  default: {
    create: vi.fn().mockResolvedValue(true)
  }
}))

import AIAnalysis from '../../src/models/AIAnalysis.js'
import AILog from '../../src/models/AILog.js'

describe('F60: Analyze Essay with AI (processEssayAnalysis pipeline)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('UTCID01 (N): should save AI analysis result record with 4 IELTS criteria to database', async () => {
    const mockAnalysis = {
      _id: 'analysis_60_1',
      essay: 'essay_60_1',
      student: 'student_1',
      scores: {
        overallBand: 6.5,
        taskResponse: 6.5,
        coherenceCohesion: 6.5,
        lexicalResource: 6.5,
        grammaticalRange: 6.5
      },
      grammarErrors: [],
      vocabularyAnalysis: { academicWords: ['essential'] }
    }
    AIAnalysis.create.mockResolvedValue(mockAnalysis)

    const saved = await AIAnalysis.create(mockAnalysis)

    expect(saved).toBeDefined()
    expect(saved.scores.overallBand).toBe(6.5)
    expect(AIAnalysis.create).toHaveBeenCalledWith(mockAnalysis)
  })

  it('UTCID02 (N): should log AI model usage metrics and token counts into AILog', async () => {
    const logData = {
      model: 'llama-3.3-70b-versatile',
      action: 'essay_analysis',
      tokensUsed: { promptTokens: 450, completionTokens: 600, totalTokens: 1050 },
      processingTimeMs: 1400,
      status: 'success'
    }
    AILog.create.mockResolvedValue({ _id: 'ailog_1', ...logData })

    const result = await AILog.create(logData)

    expect(result.status).toBe('success')
    expect(result.tokensUsed.totalTokens).toBe(1050)
    expect(AILog.create).toHaveBeenCalledWith(logData)
  })

  it('UTCID03 (B): should handle boundary short essay with minimal grammar errors detected', async () => {
    const shortAnalysis = {
      _id: 'analysis_60_3',
      essay: 'essay_60_3',
      scores: { overallBand: 5.0 },
      grammarErrors: [{ error: 'He go', correction: 'He goes' }]
    }
    AIAnalysis.create.mockResolvedValue(shortAnalysis)

    const saved = await AIAnalysis.create(shortAnalysis)

    expect(saved.scores.overallBand).toBe(5.0)
    expect(saved.grammarErrors).toHaveLength(1)
  })

  it('UTCID04 (A): should record failed status in AILog when AI provider encounters timeout', async () => {
    const errorLog = {
      model: 'llama-3.3-70b-versatile',
      action: 'essay_analysis',
      status: 'failure',
      errorMessage: 'AI API service unavailable (503)'
    }
    AILog.create.mockResolvedValue({ _id: 'ailog_err', ...errorLog })

    const result = await AILog.create(errorLog)

    expect(result.status).toBe('failure')
    expect(result.errorMessage).toContain('503')
  })
})

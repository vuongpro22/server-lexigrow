import mongoose from 'mongoose'

const suggestionSchema = new mongoose.Schema({
  type: {
    type: String,
    enum: ['improvement', 'strength'],
    required: true,
  },
  text: {
    type: String,
    required: true,
  },
  quote: {
    type: String,
    default: '',
  },
  suggestedRevision: {
    type: String,
    default: '',
  },
  quoteStart: {
    type: Number,
    default: -1,
  },
  quoteEnd: {
    type: Number,
    default: -1,
  },
  targetWord: {
    type: String,
    default: '',
  },
}, { _id: false })

const aiAnalysisSchema = new mongoose.Schema({
  essay: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Essay',
    required: true,
    unique: true,
  },
  isFallback: {
    type: Boolean,
    default: false,
  },
  isTeacherGraded: {
    type: Boolean,
    default: false,
    index: true,
  },
  rubricVersion: {
    type: String,
    default: 'rubric-v2-fixed-criteria',
  },
  cefrLevel: {
    type: String,
    enum: ['A1', 'A2', 'B1', 'B2', 'C1', 'C2', null],
    default: null,
  },
  ieltsBand: {
    type: Number,
    default: null,
  },
  cefrDistribution: {
    a1: { type: Number, default: 0 },
    a2: { type: Number, default: 0 },
    b1: { type: Number, default: 0 },
    b2: { type: Number, default: 0 },
    c1: { type: Number, default: 0 },
    c2: { type: Number, default: 0 },
    awl: { type: Number, default: 0 },
    advancedPercentage: { type: Number, default: 0 },
    matchedWords: { type: Number, default: null },
    uniqueWords: { type: Number, default: null },
    coverage: { type: Number, default: null },
  },
  overallScore: {
    type: Number,
    min: 0,
    max: 10,
    default: null,
  },
  scoringMethod: {
    type: String,
    enum: ['weighted_v1', 'llm_holistic_legacy', 'deterministic_aggregate', 'fallback_unavailable'],
    default: 'llm_holistic_legacy',
  },
  scores: {
    vocabularyDiversity: { type: Number, min: 0, max: 1, default: null },   // TTR (0-1)
    grammarAccuracy: { type: Number, min: 0, max: 10, default: null },
    coherence: { type: Number, min: 0, max: 10, default: null },
    complexityIndex: { type: Number, min: 0, max: 10, default: null },
    lexicalResource: { type: Number, min: 0, max: 10, default: null },
    promptAdherence: { type: Number, min: 0, max: 10, default: null },
    lexicalDiversityHdd: { type: Number, default: null },                 // HD-D requires at least 42 tokens
    lexicalDiversityMtld: { type: Number, default: null }                 // MTLD unavailable for fewer than 10 tokens
  },
  newWordsDetected: [{
    type: String,
    trim: true,
    lowercase: true,
  }],
  suggestions: [suggestionSchema],
  targetWordEvaluations: [{
    word: { type: String, trim: true },
    found: { type: Boolean, default: false },
    status: {
      type: String,
      enum: ['correct', 'needs_improvement', 'incorrect', 'not_used'],
      default: 'not_used'
    },
    contextQuote: { type: String, default: '' },
    feedback: { type: String, default: '' },
    suggestedUpgrade: { type: String, default: '' }
  }],
  writingStats: {
    avgSentenceLength: { type: Number, default: 0 },
    uniqueWords: { type: Number, default: 0 },
  },
  nlpStats: {
    passiveVoiceCount: { type: Number, default: 0 },
    subordinateClausesCount: { type: Number, default: null },
    subordinateClausesMethod: { type: String, enum: ['spacy_dependency', 'keyword_estimate'], default: null },
    subordinateClausesAvailable: { type: Boolean, default: false },
    repeatedWords: [{
      word: { type: String, trim: true },
      count: { type: Number, default: 0 },
      synonyms: [{ type: String }],
      suggestions: [{ type: String, trim: true }]
    }]
  },
  learningPatterns: {
    paddedSentences: { type: Boolean, default: false },
    plagiarismDetected: { type: Boolean, default: false },
    learningStatus: {
      type: String,
      enum: ['progressing', 'plateau', 'regression', 'stable', 'unknown'],
      default: 'unknown'
    },
    feedback: { type: String, default: '' }
  },
  nextEssaySuggestions: {
    transitionWords: [{ type: String, trim: true }],
    sentenceStructures: [{ type: String, trim: true }],
    generalTips: { type: String, default: '' }
  },
  plagiarismDetails: {
    isPlagiarized: { type: Boolean, default: false },
    matchedEssay: { type: mongoose.Schema.Types.ObjectId, ref: 'Essay', default: null },
    similarityScore: { type: Number, default: null },
    status: { type: String, enum: ['complete', 'insufficient_text', 'no_comparison_data', 'unavailable'], default: 'unavailable' },
    comparedEssayCount: { type: Number, default: 0 },
    method: { type: String, default: 'jaccard_3gram' },
    threshold: { type: Number, default: 0.25 },
    plagiarismType: { 
      type: String, 
      enum: ['cross_student', 'none'],
      default: 'none' 
    }
  },
  contentHash: { type: String, default: '' },
  contentRevision: { type: Number, default: -1 },
  historyOutbox: { type: [mongoose.Schema.Types.Mixed], default: [], select: false },
  // Track which system prompt was used for this analysis
  promptUsed: {
    name: { type: String, default: 'Default System Prompt' },
    promptId: { type: mongoose.Schema.Types.ObjectId, ref: 'SystemPrompt', default: null },
    isCustom: { type: Boolean, default: false },
  },
  // Output language used for the natural-language fields of this analysis
  // ('en' keeps legacy documents compatible; new analyses always set it explicitly)
  language: {
    type: String,
    enum: ['en', 'vi'],
    default: 'en',
  }
}, {
  timestamps: true,
})

const AIAnalysis = mongoose.model('AIAnalysis', aiAnalysisSchema)
export default AIAnalysis

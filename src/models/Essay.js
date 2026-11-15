import mongoose from 'mongoose'

const essaySchema = new mongoose.Schema({
  deletedAt: { type: Date, default: null },
  deletedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  revisionCounter: { type: Number, default: 0 },
  aiAnalysisStatus: {
    type: String,
    enum: ['idle', 'processing', 'completed', 'failed'],
    default: 'idle',
  },
  aiAnalysisRevision: { type: Number, default: -1 },
  title: {
    type: String,
    required: [true, 'Please add an essay title'],
    trim: true,
    maxlength: [300, 'Title cannot be more than 300 characters'],
  },
  content: {
    type: String,
    default: '',
  },
  status: {
    type: String,
    enum: ['draft', 'submitted', 'reviewed', 'needs_revision'],
    default: 'draft',
  },
  theme: {
    type: String,
    default: 'General',
    trim: true,
  },
  student: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  class: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Class',
  },
  // Assignment this essay was written for (optional)
  assignment: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Assignment',
    default: null,
  },
  // Auto-calculated stats
  wordCount: {
    type: Number,
    default: 0,
  },
  paragraphCount: {
    type: Number,
    default: 0,
  },
  sentenceCount: {
    type: Number,
    default: 0,
  },
  readingTime: {
    type: Number,  // in minutes
    default: 1,
  },
  submittedAt: {
    type: Date,
  },
}, {
  timestamps: true,
})

// Null also matches legacy documents without deletion metadata. Retained
// records remain in the raw collection for maintenance, with no public bypass.
essaySchema.pre(/^(find|countDocuments|distinct|update|replace)/, function () {
  this.where({ deletedAt: null })
})

essaySchema.pre('aggregate', function () {
  this.pipeline().unshift({ $match: { deletedAt: null } })
})

essaySchema.pre('save', function () {
  // Fence writes from a document loaded before its account was deleted.
  if (!this.isNew) this.$where = { ...this.$where, deletedAt: null }
})

export function stripHtmlToPlainText(content) {
  if (typeof content !== 'string') return ''
  return content
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim()
}

// Calculate text stats before saving and standardize content to plain text
essaySchema.pre('save', function () {
  if (this.isModified('content') && this.content) {
    const cleanText = stripHtmlToPlainText(this.content)
    this.content = cleanText
    this.wordCount = cleanText ? cleanText.split(/\s+/).filter(Boolean).length : 0
    this.paragraphCount = cleanText ? cleanText.split(/\n\n+/).filter(Boolean).length : 0
    this.sentenceCount = cleanText ? cleanText.split(/[.!?]+/).filter(Boolean).length : 0
    this.readingTime = Math.max(1, Math.ceil(this.wordCount / 200))
  }
})

// Index for querying essays by student
essaySchema.index({ student: 1, createdAt: -1 })
essaySchema.index({ student: 1, status: 1 })
essaySchema.index({ class: 1, student: 1 })

const Essay = mongoose.model('Essay', essaySchema)
export default Essay

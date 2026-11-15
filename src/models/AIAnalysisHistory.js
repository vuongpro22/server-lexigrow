import mongoose from 'mongoose'

/**
 * Immutable, append-only history of every AI grading attempt.
 *
 * Rules:
 * - One document per distinct grading request (unique per requestId).
 * - Never updated after creation: each re-analyze appends a new row so the
 *   variation across attempts stays auditable.
 * - Teacher-adjusted scores are intentionally NOT recorded here; this log
 *   captures what the AI produced, when, with which rubric version.
 */
const aiAnalysisHistorySchema = new mongoose.Schema(
  {
    essay: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Essay',
      required: true,
      index: true,
    },
    student: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      index: true,
    },
    contentRevision: { type: Number, default: 0 },
    contentHash: { type: String, index: true },
    requestId: { type: String, index: { unique: true } },
    rubricVersion: { type: String, default: 'rubric-v2-fixed-criteria' },
    gradedBy: { type: String, default: 'ai' },
    gradingStatus: { type: String, default: 'applied' },
    model: { type: String, default: '' },
    provider: { type: String, default: '' },
    overallScore: { type: Number, default: null },
    scores: { type: mongoose.Schema.Types.Mixed, default: {} },
    suggestionsCount: { type: Number, default: 0 },
    evidenceSuggestionsDropped: { type: Number, default: 0 },
    analysisMeta: { type: mongoose.Schema.Types.Mixed, default: {} },
    promptUsed: { type: mongoose.Schema.Types.Mixed, default: null },
    // Which quota reservation this grading consumed. Strict schemas drop unknown
    // paths on update, so this must be declared or the audit trail is lost.
    quota: {
      type: new mongoose.Schema({
        student: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        requestId: { type: String },
        day: { type: String },
        outcome: { type: String, enum: ['consume', 'release'] },
      }, { _id: false }),
      default: null,
    },
    analysisId: { type: mongoose.Schema.Types.ObjectId, ref: 'AIAnalysis', default: null },
  },
  { timestamps: true, versionKey: false },
)

const AIAnalysisHistory = mongoose.model('AIAnalysisHistory', aiAnalysisHistorySchema)
export default AIAnalysisHistory

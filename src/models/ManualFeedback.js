import mongoose from 'mongoose'

const manualFeedbackSchema = new mongoose.Schema({
  essay: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Essay',
    required: true,
  },
  teacher: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  scores: {
    grammar: { type: Number, min: 1, max: 10, default: 5 },
    vocabulary: { type: Number, min: 1, max: 10, default: 5 },
    coherence: { type: Number, min: 1, max: 10, default: 5 },
    complexity: { type: Number, min: 1, max: 10, default: 5 },
    // Task response, the fifth criterion of the AI rubric. Feedback saved before
    // it existed has no value; the overall score then averages the other four.
    promptAdherence: { type: Number, min: 1, max: 10 },
  },
  feedbackText: {
    type: String,
    default: '',
  },
  status: {
    type: String,
    enum: ['draft', 'submitted'],
    default: 'draft',
  },
  submittedAt: {
    type: Date,
  },
}, {
  timestamps: true,
})

// Index: one feedback per teacher per essay
manualFeedbackSchema.index({ essay: 1, teacher: 1 }, { unique: true })

const ManualFeedback = mongoose.model('ManualFeedback', manualFeedbackSchema)
export default ManualFeedback

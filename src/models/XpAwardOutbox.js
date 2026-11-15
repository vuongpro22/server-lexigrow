import mongoose from 'mongoose'

const itemSchema = new mongoose.Schema(
  {
    sourceId: { type: String, required: true },
    amount: { type: Number, required: true, min: 1 },
    meta: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { _id: false },
)

const batchSchema = new mongoose.Schema(
  {
    sourceType: { type: String, required: true },
    cap: { type: Number, required: true, min: 0 },
    baseMeta: { type: mongoose.Schema.Types.Mixed, default: {} },
    items: { type: [itemSchema], default: [] },
  },
  { _id: false },
)

const schema = new mongoose.Schema(
  {
    student: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    jobKey: { type: String, required: true },
    batches: { type: [batchSchema], default: [] },
    status: { type: String, enum: ['pending', 'processing', 'completed'], default: 'pending' },
    workerId: { type: String, default: null },
    attempts: { type: Number, default: 0, min: 0 },
    lastError: { type: String, default: '' },
    nextAttemptAt: { type: Date, default: Date.now },
    processingUntil: { type: Date, default: null },
    result: { type: mongoose.Schema.Types.Mixed, default: null },
    completedAt: { type: Date, default: null },
  },
  { timestamps: true },
)

schema.index({ student: 1, jobKey: 1 }, { unique: true })
schema.index({ status: 1, createdAt: 1 })

export default mongoose.model('XpAwardOutbox', schema)

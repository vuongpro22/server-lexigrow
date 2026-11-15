import mongoose from 'mongoose'

const schema = new mongoose.Schema(
  {
    student: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    amount: {
      type: Number,
      required: true,
      min: 0,
    },
    sourceType: {
      type: String,
      enum: ['backfill', 'daily_quest', 'game', 'vocabulary', 'essay', 'practice', 'admin'],
      required: true,
    },
    // A stable identifier for the source record. The unique index below is the
    // idempotency guard: one source can only produce one XP event.
    sourceId: {
      type: String,
      required: true,
    },
    // The quota day is separate from createdAt, which records the real award time.
    quotaDay: { type: String, default: null },
    meta: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
  },
  { timestamps: true },
)

schema.index({ student: 1, sourceType: 1, sourceId: 1 }, { unique: true })
schema.index({ student: 1, createdAt: -1 })

export default mongoose.model('XpEvent', schema)

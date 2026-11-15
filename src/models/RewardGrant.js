import mongoose from 'mongoose'

const schema = new mongoose.Schema(
  {
    student: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    source: {
      type: String,
      enum: ['level', 'badge', 'quest', 'game', 'admin'],
      required: true,
    },
    // Level number, badge key, or source record id, depending on `source`.
    sourceRef: { type: String, required: true },
    rewardType: {
      type: String,
      enum: ['badge', 'firefly', 'xp', 'voucher'],
      required: true,
    },
    rewardKey: { type: String, default: '' },
    amount: { type: Number, default: 0, min: 0 },
    meta: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true },
)

schema.index(
  { student: 1, source: 1, sourceRef: 1, rewardType: 1, rewardKey: 1 },
  { unique: true },
)
schema.index({ student: 1, rewardType: 1, createdAt: -1 })

export default mongoose.model('RewardGrant', schema)

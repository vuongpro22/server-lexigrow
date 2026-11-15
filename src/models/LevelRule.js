import mongoose from 'mongoose'

const rewardSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: ['badge', 'firefly', 'xp', 'voucher'],
      required: true,
    },
    key: { type: String, default: '' },
    amount: { type: Number, default: 0, min: 0 },
  },
  { _id: false },
)

const schema = new mongoose.Schema(
  {
    level: { type: Number, required: true, unique: true, min: 1 },
    name: { type: String, required: true, trim: true },
    minXp: { type: Number, required: true, min: 0 },
    rewards: { type: [rewardSchema], default: [] },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
)

schema.index({ minXp: 1 })

export default mongoose.model('LevelRule', schema)

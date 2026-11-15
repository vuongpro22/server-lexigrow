import mongoose from 'mongoose'

const schema = new mongoose.Schema(
  {
    student: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      unique: true,
    },
    totalXp: { type: Number, default: 0, min: 0 },
    level: { type: Number, default: 1, min: 1 },
    highestLevel: { type: Number, default: 0, min: 0 },
    lastLevelUpAt: { type: Date, default: null },
  },
  { timestamps: true },
)

export default mongoose.model('GamificationProfile', schema)

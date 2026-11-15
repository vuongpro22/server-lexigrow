import mongoose from 'mongoose'
import { GAME_KEYS } from '../constants/gamification.js'

const schema = new mongoose.Schema(
  {
    student: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    session: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'GameSession',
      required: true,
      unique: true,
    },
    gameKey: {
      type: String,
      enum: GAME_KEYS,
      required: true,
    },
    score: { type: Number, default: 0, min: 0 },
    correct: { type: Number, default: 0, min: 0 },
    total: { type: Number, default: 0, min: 0 },
    durationMs: { type: Number, default: 0, min: 0 },
    accuracy: { type: Number, default: 0, min: 0, max: 1 },
    xpEarned: { type: Number, default: 0, min: 0 },
    meta: { type: mongoose.Schema.Types.Mixed, default: {} },
    finishedAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
)

schema.index({ student: 1, createdAt: -1 })
schema.index({ student: 1, gameKey: 1, createdAt: -1 })

export default mongoose.model('GameResult', schema)

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
    gameKey: {
      type: String,
      enum: GAME_KEYS,
      required: true,
    },
    config: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    expectedRounds: {
      type: Number,
      required: true,
      min: 1,
    },
    status: {
      type: String,
      enum: ['active', 'finishing', 'finished', 'expired'],
      default: 'active',
    },
    startedAt: { type: Date, default: Date.now },
    expiresAt: { type: Date, required: true },
    lastHeartbeatAt: { type: Date, default: null },
    finishPayload: { type: mongoose.Schema.Types.Mixed, default: null },
    // Idempotency key for "start game": a double click returns the session that
    // was already created instead of opening a second one.
    startKey: { type: String, default: null },    challenges: { type: [mongoose.Schema.Types.Mixed], default: [] },
    answers: { type: [mongoose.Schema.Types.Mixed], default: [] },
    finishingAt: { type: Date, default: null },
    finishedAt: { type: Date, default: null },
  },
  { timestamps: true },
)

schema.index({ student: 1, gameKey: 1, status: 1 })
schema.index({ expiresAt: 1 })
schema.index(
  { student: 1, gameKey: 1, startKey: 1 },
  { unique: true, partialFilterExpression: { startKey: { $type: 'string' } } },
)

export default mongoose.model('GameSession', schema)

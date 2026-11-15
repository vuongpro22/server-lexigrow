import mongoose from 'mongoose'

const wordSchema = new mongoose.Schema(
  {
    id: String,
    number: Number,
    row: Number,
    col: Number,
    direction: { type: String, enum: ['across', 'down'] },
    answer: String,
    clue: String,
    clueVi: String,
    example: String,
    source: String,
  },
  { _id: false },
)

const schema = new mongoose.Schema(
  {
    student: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    day: { type: String, required: true },
    version: { type: Number, default: 1 },
    rows: Number,
    cols: Number,
    words: [wordSchema],
    cells: { type: Map, of: String, default: {} },
    solved: { type: [String], default: [] },
    assisted: { type: [String], default: [] },
    // Cell keys revealed by hints: kept on the board like solved letters.
    revealed: { type: [String], default: [] },
    revision: { type: Number, default: 0 },
    startedAt: Date,
    completedAt: Date,
    checks: { type: Number, default: 0 },
    // Source transparency: how this quest was generated (AI vs rule-based fallback)
    source: { type: String, enum: ['ai', 'mixed', 'fallback'], default: 'fallback' },
    sourceReason: { type: String, default: '' },
    // Each completed document IS one collectible. No second wallet write to race.
    reward: { type: Number, default: 0 },
  },
  { timestamps: true },
)
schema.index({ student: 1, day: 1 }, { unique: true })
schema.index({ student: 1, completedAt: -1 })
export default mongoose.model('DailyQuest', schema)

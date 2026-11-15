import mongoose from 'mongoose'

const reservationSchema = new mongoose.Schema(
  {
    sourceId: { type: String, required: true },
    amount: { type: Number, required: true, min: 1 },
  },
  { _id: false },
)

const schema = new mongoose.Schema(
  {
    student: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    sourceType: { type: String, required: true },
    day: { type: String, required: true },
    used: { type: Number, default: 0, min: 0 },
    // A reservation and its quota increment share one atomic document write.
    // Retaining reservations makes a crash before XP-event insertion recoverable.
    reservations: { type: [reservationSchema], default: [] },
  },
  { timestamps: true },
)

schema.index({ student: 1, sourceType: 1, day: 1 }, { unique: true })
schema.index(
  { student: 1, sourceType: 1, 'reservations.sourceId': 1 },
  {
    unique: true,
    partialFilterExpression: { 'reservations.sourceId': { $type: 'string' } },
  },
)

export default mongoose.model('XpQuota', schema)

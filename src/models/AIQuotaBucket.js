import mongoose from 'mongoose'

const reservationSchema = new mongoose.Schema({
  requestId: { type: String, required: true, maxlength: 128 },
  state: { type: String, enum: ['reserved', 'consumed', 'released'], required: true },
  kind: { type: String, enum: ['submission', 'revision'], required: true },
}, { _id: false })

const aiQuotaBucketSchema = new mongoose.Schema({
  student: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  day: { type: String, required: true, immutable: true },
  legacyUsed: { type: Number, default: 0, min: 0 },
  consumed: { type: Number, default: 0, min: 0 },
  used: { type: Number, default: 0, min: 0 },
  reserved: { type: Number, default: 0, min: 0 },
  reservations: { type: [reservationSchema], default: [] },
}, { timestamps: true })

aiQuotaBucketSchema.index({ student: 1, day: 1 }, { unique: true })
aiQuotaBucketSchema.index({ student: 1, 'reservations.requestId': 1 })

export default mongoose.model('AIQuotaBucket', aiQuotaBucketSchema)

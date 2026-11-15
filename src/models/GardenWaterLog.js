import mongoose from 'mongoose'

const schema = new mongoose.Schema(
  {
    student: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    theme: { type: String, required: true },
    // Local calendar day of the student, so the daily quota follows their
    // timezone instead of the server's.
    day: { type: String, required: true },
    count: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true },
)

schema.index({ student: 1, theme: 1, day: 1 }, { unique: true })
export default mongoose.model('GardenWaterLog', schema)

import mongoose from 'mongoose'

const teacherQuotaLockSchema = new mongoose.Schema({
  owner: { type: String, default: null },
  leaseUntil: { type: Date, required: true },
}, {
  timestamps: true,
  versionKey: false,
})

export default mongoose.models.TeacherQuotaLock || mongoose.model('TeacherQuotaLock', teacherQuotaLockSchema)

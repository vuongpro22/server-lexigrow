import mongoose from 'mongoose'

const announcementSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: true,
      trim: true,
      maxlength: 160,
    },
    body: {
      type: String,
      required: true,
      trim: true,
      maxlength: 5000,
    },
    audience: {
      type: String,
      enum: ['all', 'student', 'teacher', 'parent'],
      default: 'all',
      index: true,
    },
    priority: {
      type: String,
      enum: ['normal', 'important', 'critical'],
      default: 'normal',
    },
    status: {
      type: String,
      enum: ['draft', 'published', 'archived'],
      default: 'draft',
      index: true,
    },
    publishAt: {
      type: Date,
      default: null,
    },
    expiresAt: {
      type: Date,
      default: null,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
  },
  { timestamps: true }
)

announcementSchema.path('expiresAt').validate(function validateExpiryAfterPublish(val) {
  if (!val || !this.publishAt) return true
  return val > this.publishAt
}, 'expiresAt must be after publishAt')

announcementSchema.index({ status: 1, publishAt: -1 })
announcementSchema.index({ status: 1, expiresAt: 1 })

export default mongoose.model('Announcement', announcementSchema)

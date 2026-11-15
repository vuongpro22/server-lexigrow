import mongoose from 'mongoose'

const alertSchema = new mongoose.Schema({
  student: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  },
  class: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Class',
  },
  teacher: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null,
  },
  type: {
    type: String,
    enum: ['critical', 'warning', 'info', 'success'],
    required: true,
  },
  metric: {
    type: String,
    required: true,
  },
  // Optional stable identifier of the item that triggered the alert (e.g. the
  // missed assignment id). Lets resolved deadline alerts stay dismissed
  // instead of being recreated and emailed again on the next scan.
  sourceId: {
    type: String,
    default: '',
  },
  detail: {
    type: String,
    required: true,
  },
  icon: {
    type: String,
    default: 'info',
  },
  isRead: {
    type: Boolean,
    default: false,
  },
  isResolved: {
    type: Boolean,
    default: false,
  },
  viewedByParents: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  }],
}, {
  timestamps: true,
})

alertSchema.index({ teacher: 1, isRead: 1, createdAt: -1 })
alertSchema.index({ teacher: 1, type: 1 })
alertSchema.index({ student: 1, isResolved: 1, createdAt: -1 })
alertSchema.index({ student: 1, metric: 1, sourceId: 1 })

const Alert = mongoose.model('Alert', alertSchema)
export default Alert

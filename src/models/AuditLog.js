import mongoose from 'mongoose'

const auditLogSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null,
  },
  actorType: {
    type: String,
    enum: ['user', 'system'],
    default: 'user',
  },
  actorName: { type: String, default: '' },
  actorEmail: { type: String, default: '' },
  actorRole: { type: String, default: '' },
  action: {
    type: String,
    required: true
  },
  targetType: {
    type: String,
    required: true
  },
  targetId: {
    type: String
  },
  details: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  }
}, {
  timestamps: { createdAt: true, updatedAt: false }
})

// Indexing for filtering and entity history lookups. No TTL: retention of
// audit history is a policy decision, and a TTL index deletes old rows
// irreversibly as soon as it is built.
auditLogSchema.index({ createdAt: -1 })
auditLogSchema.index({ action: 1, createdAt: -1 })
auditLogSchema.index({ user: 1, createdAt: -1 })
auditLogSchema.index({ targetType: 1, targetId: 1, createdAt: -1 })

const AuditLog = mongoose.model('AuditLog', auditLogSchema)
export default AuditLog

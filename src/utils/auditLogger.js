import AuditLog from '../models/AuditLog.js'
import User from '../models/User.js'

/**
 * Log an administrative or important system action.
 * @param {string} userId - ID of user who performed the action
 * @param {string} action - Action identifier (e.g. 'CREATE_CLASS')
 * @param {string} targetType - Model/entity type affected (e.g. 'Class')
 * @param {string} targetId - ID of entity affected
 * @param {object} details - Additional metadata or payload
 */
export const logAction = async (userId, action, targetType, targetId, details = {}) => {
  try {
    if (!userId) {
      console.warn(`[AuditLog] Blocked logging action '${action}' due to missing userId.`)
      return
    }
    let actor = null
    try {
      const query = User.findById(userId)
      actor = await (typeof query?.select === 'function' ? query.select('name email role').lean() : query)
    } catch {
      // Audit records remain writeable even if the actor was already removed.
    }
    await AuditLog.create({
      user: userId,
      actorType: 'user',
      actorName: actor?.name || '',
      actorEmail: actor?.email || '',
      actorRole: actor?.role || '',
      action,
      targetType,
      targetId: targetId ? targetId.toString() : null,
      details
    })
  } catch (err) {
    console.error('[AuditLog] Failed to create audit log:', err.message)
  }
}

/**
 * Log a system/scheduler-initiated action without a human user actor.
 */
export const logSystemAction = async (action, targetType, targetId, details = {}) => {
  try {
    await AuditLog.create({
      user: null,
      actorType: 'system',
      actorName: 'System',
      actorEmail: '',
      actorRole: 'system',
      action,
      targetType,
      targetId: targetId ? targetId.toString() : null,
      details,
    })
  } catch (err) {
    console.error('[AuditLog] Failed to create system audit log:', err.message)
  }
}

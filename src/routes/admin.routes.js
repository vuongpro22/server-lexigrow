import { Router } from 'express'
import {
  getAuditLogs,
  getSystemAnalytics,
  seedMockData,
  getConfigs,
  updateConfigs,
  getAILogs,
  getAIMonitoringAnalytics,
  forceReleaseMutationLock,
} from '../controllers/admin.controller.js'
import {
  getUsers,
  updateUserStatus,
  updateUserRole,
  resetUserPassword,
  deleteUser,
  getPendingApprovals,
  approveUser,
  rejectUser,
  sendStudentVerification,
} from '../controllers/admin.user.controller.js'
import {
  listAnnouncements,
  getAnnouncementStats,
  createAnnouncement,
  updateAnnouncement,
  deleteAnnouncement,
} from '../controllers/admin.announcement.controller.js'

import { protect, authorize } from '../middleware/auth.middleware.js'
import { adminLimiter } from '../middleware/rateLimit.middleware.js'

const router = Router()

// Seed creates accounts with a known default password, so it must never be
// reachable in production.
const devOnly = (req, res, next) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(403).json({ success: false, message: 'This endpoint is disabled in production' })
  }
  next()
}

router.use(protect)
router.use(authorize('admin'))
router.use(adminLimiter)

// ── System / Audit ────────────────────────────────────────
router.get('/logs', getAuditLogs)
router.get('/analytics', getSystemAnalytics)
router.post('/logs/seed', devOnly, seedMockData)
router.delete('/mutation-lock', forceReleaseMutationLock)

// ── Config routes ─────────────────────────────────────────
router.get('/config', getConfigs)
router.put('/config', updateConfigs)

// ── AI Monitoring routes ──────────────────────────────────
router.get('/ai/logs', getAILogs)
router.get('/ai/monitoring', getAIMonitoringAnalytics)

// ── User Management routes ────────────────────────────────
router.get('/users', getUsers)
router.patch('/users/:id/status', updateUserStatus)
router.patch('/users/:id/role', updateUserRole)
router.post('/users/:id/reset-password', resetUserPassword)
router.delete('/users/:id', deleteUser)

// ── Approval routes ───────────────────────────────────────
router.get('/approvals', getPendingApprovals)
router.post('/approvals/:id/approve', approveUser)
router.post('/approvals/:id/reject', rejectUser)
router.post('/approvals/:id/verify-via-student', sendStudentVerification)

// ── Announcement routes ───────────────────────────────────
router.get('/announcements', listAnnouncements)
router.get('/announcements/stats', getAnnouncementStats)
router.post('/announcements', createAnnouncement)
router.patch('/announcements/:id', updateAnnouncement)
router.delete('/announcements/:id', deleteAnnouncement)

export default router

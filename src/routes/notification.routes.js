import { Router } from 'express'
import {
  getNotifications,
  markNotificationRead,
  markAllNotificationsRead,
  getUnreadCount,
  respondParentRequest,
  getPublishedAnnouncements,
} from '../controllers/notification.controller.js'
import { protect, optionalAuth } from '../middleware/auth.middleware.js'

const router = Router()

// Announcements must reach visitors who have not signed up yet, so this one
// route resolves the token when present and falls back to the guest audience.
router.get('/announcements', optionalAuth, getPublishedAnnouncements)

// Every other route requires a signed-in student, parent or teacher.
router.use(protect)

router.get('/', getNotifications)
router.get('/unread-count', getUnreadCount)
router.patch('/read-all', markAllNotificationsRead)
router.patch('/:id/read', markNotificationRead)
router.post('/:id/respond-parent-request', respondParentRequest)

export default router

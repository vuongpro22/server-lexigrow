import { Router } from 'express'
import {
  getNotifications,
  markNotificationRead,
  markAllNotificationsRead,
  getUnreadCount,
  respondParentRequest,
  getPublishedAnnouncements,
} from '../controllers/notification.controller.js'
import { protect } from '../middleware/auth.middleware.js'

const router = Router()

// Tất cả route đều yêu cầu đăng nhập (student, parent, teacher đều dùng được)
router.use(protect)

router.get('/announcements', getPublishedAnnouncements)
router.get('/', getNotifications)
router.get('/unread-count', getUnreadCount)
router.patch('/read-all', markAllNotificationsRead)
router.patch('/:id/read', markNotificationRead)
router.post('/:id/respond-parent-request', respondParentRequest)

export default router

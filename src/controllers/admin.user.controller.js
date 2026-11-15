import User from '../models/User.js'
import Class from '../models/Class.js'
import asyncHandler from '../utils/asyncHandler.js'
import ErrorResponse from '../utils/ErrorResponse.js'
import sendEmail from '../utils/sendEmail.js'
import { logAction } from '../utils/auditLogger.js'
import { escapeRegex } from '../utils/escapeRegex.js'
import Notification from '../models/Notification.js'
import ParentStudentLink from '../models/ParentStudentLink.js'
import ChildLinkCode from '../models/ChildLinkCode.js'
import { disconnectUserSockets, syncParentLinkedRooms } from '../services/socket.service.js'
import { randomBytes } from 'node:crypto'
import AuditLog from '../models/AuditLog.js'
import Subscription from '../models/Subscription.js'
import Essay from '../models/Essay.js'
import { withAdminMutationLock } from '../services/adminMutationLock.service.js'

const adminMutationHandler = handler => asyncHandler(async (req, res, next) => {
  const respond = await withAdminMutationLock(() => handler(req, res, next))
  return respond()
})

/* ── Helpers ─────────────────────────────────────────────── */
// User-controlled text is interpolated into HTML emails, so it must be escaped
// before it reaches the markup — otherwise a display name like
// "<img src=x onerror=...>" becomes live HTML in the recipient's mail client.
const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch])
}

function sanitize(user) {
  const obj = user.toObject ? user.toObject() : { ...user }
  delete obj.password
  delete obj.resetPasswordCode
  return obj
}

// ─────────────────────────────────────────────────────────────
// GET /api/admin/users
// Query: page, limit, search, role, status
// ─────────────────────────────────────────────────────────────
export const getUsers = asyncHandler(async (req, res) => {
  const { search = '', role, status } = req.query
  const page  = Math.max(1, parseInt(req.query.page, 10) || 1)
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20))
  const query = { accountStatus: { $ne: 'deleted' } }
  if (status === 'deleted') throw new ErrorResponse('Deleted users are not listed', 400)

  if (search) {
    const pattern = escapeRegex(search)
    query.$or = [
      { name:  { $regex: pattern, $options: 'i' } },
      { email: { $regex: pattern, $options: 'i' } },
    ]
  }
  if (role   && role   !== 'all') query.role          = role
  if (status && status !== 'all') query.accountStatus = status

  const skip  = (page - 1) * limit
  const total = await User.countDocuments(query)

  const users = await User.find(query)
    .select('-password -resetPasswordCode')
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit)

  // Summary counts (always over the full dataset, not the filtered one)
  const [byRole, byStatus] = await Promise.all([
    User.aggregate([{ $match: { accountStatus: { $ne: 'deleted' } } }, { $group: { _id: '$role', count: { $sum: 1 } } }]),
    User.aggregate([{ $match: { accountStatus: { $ne: 'deleted' } } }, { $group: { _id: '$accountStatus', count: { $sum: 1 } } }]),
  ])

  const roleCounts   = Object.fromEntries(byRole.map(r  => [r._id,  r.count]))
  const statusCounts = Object.fromEntries(byStatus.map(s => [s._id, s.count]))

  res.status(200).json({
    success: true,
    total,
    page,
    pages: Math.ceil(total / limit),
    data: users,
    summary: { roleCounts, statusCounts },
  })
})

// ─────────────────────────────────────────────────────────────
// PATCH /api/admin/users/:id/status
// body: { status: 'active'|'suspended'|'rejected', note? }
// ─────────────────────────────────────────────────────────────
export const updateUserStatus = adminMutationHandler(async (req, res) => {
  const { status, note = '' } = req.body
  const VALID = ['active', 'suspended', 'pending_approval', 'rejected']
  if (!VALID.includes(status)) throw new ErrorResponse('Invalid status value', 400)

  const user = await User.findById(req.params.id)
  if (!user) throw new ErrorResponse('User not found', 404)
  if (user.accountStatus === 'deleted') throw new ErrorResponse('User has been deleted', 404)
  if (user.role === 'admin') throw new ErrorResponse('Cannot change status of an admin account', 403)

  const oldStatus   = user.accountStatus
  user.accountStatus = status
  user.statusNote    = note
  await user.save()
  if (status !== 'active') await disconnectUserSockets(user._id)

  console.log(`[ADMIN] ${req.user.name} changed ${user.email} status: ${oldStatus} → ${status}`)

  await logAction(req.user._id, 'ADMIN_UPDATE_USER_STATUS', 'User', user._id, {
    email: user.email,
    oldStatus,
    newStatus: status,
    note,
  })

  return () => res.status(200).json({ success: true, data: sanitize(user) })
})

// ─────────────────────────────────────────────────────────────
// PATCH /api/admin/users/:id/role
// body: { role: 'student'|'teacher'|'parent' }
// ─────────────────────────────────────────────────────────────
export const updateUserRole = adminMutationHandler(async (req, res) => {
  const { role } = req.body
  if (!['student', 'teacher', 'parent', 'admin'].includes(role)) {
    throw new ErrorResponse('Invalid role', 400)
  }

  const user = await User.findById(req.params.id)
  if (!user) throw new ErrorResponse('User not found', 404)
  if (user.accountStatus === 'deleted') throw new ErrorResponse('User has been deleted', 404)
  if (user._id.toString() === req.user._id.toString()) {
    throw new ErrorResponse('Cannot change your own role', 403)
  }

  if (user.role === 'admin' && role !== 'admin') {
    const adminCount = await User.countDocuments({ role: 'admin', accountStatus: 'active' })
    if (user.accountStatus === 'active' && adminCount <= 1) {
      throw new ErrorResponse('Hệ thống phải có ít nhất một quản trị viên đang hoạt động.', 409)
    }
  }
  if (user.role === 'teacher' && role !== 'teacher' && await Class.exists({ teacher: user._id, status: 'active' })) {
    throw new ErrorResponse('Transfer or archive this teacher’s active classes before changing their role', 409)
  }
  if (user.role === 'student' && role !== 'student' && await Class.exists({ $or: [{ students: user._id }, { pendingStudents: user._id }] })) {
    throw new ErrorResponse('Remove this student from their classes before changing their role', 409)
  }
  if (role !== user.role && (user.role === 'parent' || user.role === 'student')) {
    const linkField = user.role === 'parent' ? 'parent' : 'student'
    const hasLinks = (user.children?.length || 0) > 0 || (user.parents?.length || 0) > 0
      || await ParentStudentLink.exists({ [linkField]: user._id, status: 'active' })
    if (hasLinks) {
      throw new ErrorResponse('Unlink this user from their parent/student links before changing their role', 409)
    }
  }
  if (role !== user.role && await Subscription.exists({ user: user._id, status: 'active', endDate: { $gt: new Date() } })) {
    throw new ErrorResponse('Cannot change role while a subscription is active', 409)
  }

  const oldRole  = user.role
  user.role = role
  await user.save()

  console.log(`[ADMIN] ${req.user.name} changed ${user.email} role: ${oldRole} → ${role}`)

  await logAction(req.user._id, 'ADMIN_UPDATE_ROLE', 'User', user._id, { oldRole, newRole: role })

  return () => res.status(200).json({ success: true, data: sanitize(user) })
})

// ─────────────────────────────────────────────────────────────
// POST /api/admin/users/:id/reset-password
// body: { newPassword }
// ─────────────────────────────────────────────────────────────
export const resetUserPassword = asyncHandler(async (req, res) => {
  const { newPassword } = req.body
  if (!newPassword || newPassword.length < 6) {
    throw new ErrorResponse('Password must be at least 6 characters', 400)
  }

  const user = await User.findById(req.params.id).select('+password')
  if (!user) throw new ErrorResponse('User not found', 404)
  if (user.accountStatus === 'deleted') throw new ErrorResponse('User has been deleted', 404)
  if (user.role === 'admin' && user._id.toString() !== req.user._id.toString()) {
    throw new ErrorResponse('Cannot reset the password of another admin', 403)
  }

  user.password = newPassword // pre-save hook will hash it
  await user.save()
  await disconnectUserSockets(user._id)

  console.log(`[ADMIN] ${req.user.name} reset password for ${user.email}`)

  // Never record the new password itself — only that it happened and to whom.
  await logAction(req.user._id, 'ADMIN_RESET_USER_PASSWORD', 'User', user._id, {
    email: user.email,
  })

  res.status(200).json({ success: true, message: 'Password has been reset successfully' })
})

// ─────────────────────────────────────────────────────────────
// DELETE /api/admin/users/:id
// ─────────────────────────────────────────────────────────────
export const deleteUser = adminMutationHandler(async (req, res) => {
  const user = await User.findById(req.params.id)
  if (!user) throw new ErrorResponse('User not found', 404)
  if (user.accountStatus === 'deleted') throw new ErrorResponse('User has been deleted', 404)
  if (user.role === 'admin') throw new ErrorResponse('Cannot delete an admin account', 403)
  if (user._id.toString() === req.user._id.toString()) {
    throw new ErrorResponse('Cannot delete your own account', 403)
  }

  const originalEmail = user.email
  const originalName = user.name
  // Capture the parents before user.parents is cleared. They are needed to
  // evict live parent sockets from the deleted student's rooms afterwards.
  const linkedParentIds = user.role === 'student'
    ? [...new Set((user.parents || []).map(parentId => String(parentId?._id || parentId)))]
    : []
  await AuditLog.updateMany(
    { user: user._id, actorEmail: { $in: ['', null] } },
    { $set: { actorName: originalName, actorEmail: originalEmail, actorRole: user.role } }
  )
  user.accountStatus = 'deleted'
  user.name = 'Deleted user'
  user.email = `deleted-${user._id}@lexigrow.invalid`
  user.googleId = ''
  user.avatar = ''
  user.children = []
  user.parents = []
  user.password = randomBytes(32).toString('hex')
  user.resetPasswordCode = ''
  user.resetPasswordExpire = undefined
  await user.save()
  await disconnectUserSockets(user._id)

  // Revoke both directions of every parent-student link and remove every
  // notification that still references the deleted account. This covers:
  //  - parent deletion -> student-side "approve parent" prompts
  //  - student deletion -> parent-side alerts that point at the student
  const [revokedLinks, deletedNotifications] = await Promise.all([
    ParentStudentLink.updateMany(
      { $or: [{ parent: user._id }, { student: user._id }], status: 'active' },
      { $set: { status: 'revoked', revokedAt: new Date(), revokedBy: req.user._id } }
    ),
    Notification.deleteMany({
      $or: [{ recipient: user._id }, { relatedUser: user._id }],
    }),
  ])

  // Pull the dead id from both denormalised arrays regardless of which side
  // of the relationship the deleted account was on.
  await Promise.all([
    User.updateMany({ children: user._id }, { $pull: { children: user._id } }),
    User.updateMany({ parents: user._id }, { $pull: { parents: user._id } }),
  ])

  // A deleted student must not leave a still-valid one-time code behind that
  // could be used against a recycled/recreated account.
  const deletedLinkCodes = user.role === 'student'
    ? await ChildLinkCode.deleteMany({ student: user._id })
    : null

  // Parents can still have a live socket in the deleted student's personal
  // room / class rooms. Evict them now that the links are gone.
  if (linkedParentIds.length > 0) {
    await Promise.all(linkedParentIds.map(parentId =>
      syncParentLinkedRooms(parentId, { revokedStudentId: user._id })
    ))
  }

  // Retain authored essays for audit/recovery while removing them from live use.
  const deletedEssays = await Essay.updateMany(
    { student: user._id },
    { $set: { deletedAt: new Date(), deletedBy: req.user._id } },
  )

  // Keep financial transactions, but stop an active subscription on a deleted account.
  const cancelledSubs = await Subscription.updateMany(
    { user: user._id, status: 'active' },
    { $set: { status: 'cancelled' } }
  )

  // Drop the dead reference so class rosters and studentCount stop counting a
  // user that no longer exists.
  await Class.updateMany(
    { $or: [{ students: user._id }, { pendingStudents: user._id }] },
    { $pull: { students: user._id, pendingStudents: user._id } }
  )

  const auditDetails = {
    email: originalEmail,
    role: user.role,
    name: originalName,
  }
  if (deletedEssays.modifiedCount > 0) auditDetails.softDeletedEssays = deletedEssays.modifiedCount
  if (cancelledSubs.modifiedCount > 0) auditDetails.cancelledSubscriptions = cancelledSubs.modifiedCount
  if (revokedLinks?.modifiedCount > 0) auditDetails.revokedParentLinks = revokedLinks.modifiedCount
  if (deletedNotifications?.deletedCount > 0) auditDetails.deletedNotifications = deletedNotifications.deletedCount
  if (deletedLinkCodes?.deletedCount > 0) auditDetails.deletedLinkCodes = deletedLinkCodes.deletedCount

  if (user.role === 'teacher') {
    const archiveResult = await Class.updateMany(
      { teacher: user._id },
      { $set: { status: 'archived' } }
    )
    const archivedCount = archiveResult?.modifiedCount ?? archiveResult?.nModified ?? 0
    if (archivedCount > 0) {
      auditDetails.archivedClasses = archivedCount
    }
  }

  console.log(`[ADMIN] ${req.user.name} deleted user ${originalEmail}`)

  await logAction(req.user._id, 'ADMIN_DELETE_USER', 'User', user._id, auditDetails)

  return () => res.status(200).json({ success: true, message: 'User deleted successfully' })
})

// ─────────────────────────────────────────────────────────────
// GET /api/admin/approvals
// Lists all users with accountStatus = 'pending_approval'
// ─────────────────────────────────────────────────────────────
export const getPendingApprovals = asyncHandler(async (req, res) => {
  const { role } = req.query
  const page  = Math.max(1, parseInt(req.query.page, 10) || 1)
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 30))
  const query = { accountStatus: 'pending_approval' }
  if (role && role !== 'all') query.role = role

  const skip  = (page - 1) * limit
  const total = await User.countDocuments(query)
  const users = await User.find(query)
    .populate('children', 'name email')
    .select('-password -resetPasswordCode')
    .sort({ createdAt: 1 }) // oldest first — FIFO
    .skip(skip)
    .limit(limit)

  res.status(200).json({
    success: true,
    total,
    page,
    limit,
    pages: Math.max(1, Math.ceil(total / limit)),
    data: users,
  })
})

// ─────────────────────────────────────────────────────────────
// POST /api/admin/approvals/:id/approve
// ─────────────────────────────────────────────────────────────
export const approveUser = adminMutationHandler(async (req, res) => {
  const user = await User.findById(req.params.id)
  if (!user) throw new ErrorResponse('User not found', 404)
  if (user.accountStatus !== 'pending_approval') {
    throw new ErrorResponse('User is not in pending_approval status', 400)
  }

  user.accountStatus = 'active'
  user.statusNote    = `Approved by ${req.user.name} on ${new Date().toISOString()}`
  await user.save()

  // Send approval email
  const safeName = escapeHtml(user.name)
  const safeRole = escapeHtml(user.role)
  try {
    await sendEmail({
      email:   user.email,
      subject: '[LexiGrow] Tài khoản của bạn đã được phê duyệt!',
      message: `Xin chào ${user.name}, tài khoản ${user.role} của bạn trên LexiGrow đã được Admin phê duyệt. Bạn có thể đăng nhập ngay bây giờ.`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;padding:24px;border:1px solid #e0e7ff;border-radius:12px">
          <h2 style="color:#005bbf;text-align:center">✅ Tài khoản đã được duyệt!</h2>
          <p>Xin chào <strong>${safeName}</strong>,</p>
          <p>Tài khoản <strong>${safeRole}</strong> của bạn trên hệ thống <strong>LexiGrow</strong> đã được Admin phê duyệt thành công.</p>
          <p>Bạn có thể đăng nhập và bắt đầu sử dụng hệ thống ngay bây giờ.</p>
          <div style="text-align:center;margin:24px 0">
            <a href="${process.env.CLIENT_URL || 'http://localhost:5173'}/login" 
               style="background:#005bbf;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:700">
              Đăng nhập ngay
            </a>
          </div>
          <hr style="border:0;border-top:1px solid #eee;margin:20px 0"/>
          <p style="color:#999;font-size:12px;text-align:center">LexiGrow © 2026 - Measured Writing Growth</p>
        </div>
      `,
    })
  } catch (err) {
    console.error('[ADMIN] Failed to send approval email:', err.message)
    // Non-blocking: approval still succeeds
  }

  console.log(`[ADMIN] ${req.user.name} APPROVED ${user.email} (${user.role})`)

  await logAction(req.user._id, 'ADMIN_APPROVE_USER', 'User', user._id, {
    email: user.email,
    role: user.role,
  })

  return () => res.status(200).json({ success: true, data: sanitize(user) })
})

// ─────────────────────────────────────────────────────────────
// POST /api/admin/approvals/:id/reject
// body: { reason? }
// ─────────────────────────────────────────────────────────────
export const rejectUser = adminMutationHandler(async (req, res) => {
  const { reason = 'Không đáp ứng yêu cầu của hệ thống.' } = req.body

  const user = await User.findById(req.params.id)
  if (!user) throw new ErrorResponse('User not found', 404)
  if (user.accountStatus !== 'pending_approval') {
    throw new ErrorResponse('User is not in pending_approval status', 400)
  }

  user.accountStatus = 'rejected'
  user.statusNote    = `Rejected by ${req.user.name}: ${reason}`
  await user.save()

  // Send rejection email
  const safeName = escapeHtml(user.name)
  const safeRole = escapeHtml(user.role)
  const safeReason = escapeHtml(reason)
  try {
    await sendEmail({
      email:   user.email,
      subject: '[LexiGrow] Đơn đăng ký tài khoản không được chấp nhận',
      message: `Xin chào ${user.name}, đơn đăng ký tài khoản của bạn đã bị từ chối. Lý do: ${reason}`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;padding:24px;border:1px solid #fde8e8;border-radius:12px">
          <h2 style="color:#ba1a1a;text-align:center">❌ Đơn đăng ký không được chấp nhận</h2>
          <p>Xin chào <strong>${safeName}</strong>,</p>
          <p>Chúng tôi rất tiếc phải thông báo rằng đơn đăng ký tài khoản <strong>${safeRole}</strong> của bạn trên LexiGrow không được chấp nhận.</p>
          <div style="background:#fff3f3;border-left:4px solid #ba1a1a;padding:12px 16px;border-radius:6px;margin:16px 0">
            <strong>Lý do:</strong> ${safeReason}
          </div>
          <p>Nếu bạn cho rằng có sự nhầm lẫn, vui lòng liên hệ với chúng tôi để được hỗ trợ.</p>
          <hr style="border:0;border-top:1px solid #eee;margin:20px 0"/>
          <p style="color:#999;font-size:12px;text-align:center">LexiGrow © 2026 - Measured Writing Growth</p>
        </div>
      `,
    })
  } catch (err) {
    console.error('[ADMIN] Failed to send rejection email:', err.message)
  }

  console.log(`[ADMIN] ${req.user.name} REJECTED ${user.email} (${user.role}). Reason: ${reason}`)

  await logAction(req.user._id, 'ADMIN_REJECT_USER', 'User', user._id, {
    email: user.email,
    role: user.role,
    reason,
  })

  return () => res.status(200).json({ success: true, data: sanitize(user) })
})

// ─────────────────────────────────────────────────────────────
// POST /api/admin/approvals/:id/verify-via-student
// ─────────────────────────────────────────────────────────────
export const sendStudentVerification = asyncHandler(async (req, res) => {
  const parent = await User.findById(req.params.id)
  if (!parent) throw new ErrorResponse('Parent user not found', 404)
  if (parent.role !== 'parent') throw new ErrorResponse('User is not a parent account', 400)
  if (parent.accountStatus !== 'pending_approval') {
    throw new ErrorResponse('User is not in pending_approval status', 400)
  }
  if (!parent.children || parent.children.length === 0) {
    throw new ErrorResponse('No children associated with this parent', 400)
  }

  const requestedChildId = req.body?.childId
  const isPresent = requestedChildId && parent.children.some(c => (c?._id || c).toString() === requestedChildId.toString())
  if (requestedChildId && !isPresent) {
    throw new ErrorResponse('Child is not associated with this parent', 400)
  }
  const fallbackChildId = parent.children[0]?._id || parent.children[0]
  const childId = isPresent ? requestedChildId : fallbackChildId
  const child = await User.findById(childId)
  if (!child || child.role !== 'student' || child.accountStatus !== 'active') {
    throw new ErrorResponse('Child student not found', 404)
  }

  // Create verification notification for the student
  const notification = await Notification.create({
    recipient: child._id,
    sender: req.user._id,
    title: 'Parent Verification Request',
    message: `Parent ${parent.name} (${parent.email}) wants to link to your account. Please confirm.`,
    type: 'parent_notice',
    link: '',
    relatedUser: parent._id,
  })

  // Send socket realtime notification
  try {
    const { sendNotificationToUser } = await import('../services/socket.service.js')
    sendNotificationToUser(child._id, {
      ...notification.toObject(),
      sender: { _id: req.user._id, name: req.user.name, role: req.user.role }
    })
  } catch (socketErr) {
    console.error('[ADMIN] Realtime notification socket failed to emit:', socketErr.message)
  }

  // Mark parent status as verification sent
  parent.statusNote = `Verification request sent to student ${child.name} (${child.email}) on ${new Date().toISOString()}`
  await parent.save()

  console.log(`[ADMIN] Verification sent to student ${child.email} for parent approval ${parent.email}`)

  await logAction(req.user._id, 'ADMIN_SEND_STUDENT_VERIFICATION', 'User', parent._id, {
    parentEmail: parent.email,
    childEmail: child.email,
  })

  res.status(200).json({ success: true, data: sanitize(parent) })
})

import User from '../models/User.js'
import ErrorResponse from '../utils/ErrorResponse.js'
import asyncHandler from '../utils/asyncHandler.js'
import { normalizeEmail } from '../utils/normalizeEmail.js'
import { createHash, randomInt } from 'node:crypto'
import sendEmail from '../utils/sendEmail.js'
import { setAuthCookie } from '../utils/authCookie.js'
import { EMAIL_PATTERN } from '../utils/accountValidation.js'

const hashCode = code => createHash('sha256').update(code).digest('hex')
const publicProfile = user => {
  const data = user.toObject ? user.toObject() : { ...user }
  for (const key of ['password', 'passwordVersion', 'emailChange', 'resetPasswordCode', 'resetPasswordExpire']) delete data[key]
  return data
}

/**
 * @desc    Get current user profile
 * @route   GET /api/profile
 * @access  Private
 */
export const getProfile = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user._id)
  if (!user) throw new ErrorResponse('User not found', 404)
  res.status(200).json({ success: true, data: publicProfile(user) })
})

/**
 * @desc    Update profile info
 * @route   PUT /api/profile
 * @access  Private
 */
export const updateProfile = asyncHandler(async (req, res) => {
  const { name, email, institution, englishLevel, avatar } = req.body
  const user = await User.findById(req.user._id)
  if (!user) throw new ErrorResponse('User not found', 404)
  const nextEmail = email === undefined ? user.email : normalizeEmail(email)
  const changingEmail = nextEmail !== user.email
  let code
  if (changingEmail) {
    if (!EMAIL_PATTERN.test(nextEmail)) throw new ErrorResponse('Invalid email address', 400)
    if (typeof req.body.currentPassword !== 'string' || !req.body.currentPassword) {
      throw new ErrorResponse('Vui lòng nhập mật khẩu hiện tại để đổi email.', 400)
    }
    const credentials = await User.findById(user._id).select('+password')
    if (!await credentials.matchPassword(req.body.currentPassword)) {
      throw new ErrorResponse('Mật khẩu hiện tại không chính xác.', 401)
    }
    if (await User.exists({ email: nextEmail, _id: { $ne: user._id } })) {
      throw new ErrorResponse('Email này đã được sử dụng.', 409)
    }
    code = randomInt(100000, 1000000).toString()
    user.emailChange = { email: nextEmail, originalEmail: user.email, codeHash: hashCode(code),
      expiresAt: new Date(Date.now() + 15 * 60000), passwordVersion: credentials.passwordVersion || 0 }
  }

  if (avatar !== undefined && avatar !== user.avatar) {
    const match = typeof avatar === 'string' && avatar.match(/^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$/)
    if (avatar !== '' && (!match || match[2].length % 4 !== 0 || Buffer.byteLength(match[2], 'base64') > 2 * 1024 * 1024)) {
      throw new ErrorResponse('Avatar must be a PNG, JPEG, WebP or GIF image up to 2 MB.', 400)
    }
    user.avatar = avatar
  }

  if (name) user.name = name
  if (institution !== undefined) user.institution = institution
  if (englishLevel) user.englishLevel = englishLevel

  await user.save()
  if (changingEmail) {
    try {
      await sendEmail({ email: nextEmail, subject: 'Xác nhận đổi email LexiGrow',
        message: `Mã xác nhận đổi email của bạn là ${code}. Mã có hiệu lực trong 15 phút.` })
    } catch {
      await User.updateOne({ _id: user._id, 'emailChange.codeHash': hashCode(code) }, { $unset: { emailChange: 1 } })
      throw new ErrorResponse('Không thể gửi mã xác nhận. Vui lòng thử lại.', 503)
    }
  }
  res.status(changingEmail ? 202 : 200).json({ success: true, data: publicProfile(user),
    ...(changingEmail ? { pendingEmail: nextEmail, message: 'Nhập mã gửi đến email mới để hoàn tất thay đổi.' } : {}) })
})

export const confirmEmailChange = asyncHandler(async (req, res) => {
  const { code } = req.body
  if (typeof code !== 'string' || !/^\d{6}$/.test(code)) throw new ErrorResponse('Mã xác nhận không hợp lệ.', 400)
  const user = await User.findById(req.user._id).select('+emailChange')
  const pending = user?.emailChange
  if (!pending || pending.expiresAt <= new Date() || pending.codeHash !== hashCode(code)
    || pending.originalEmail !== user.email || pending.passwordVersion !== (user.passwordVersion || 0)) {
    throw new ErrorResponse('Mã xác nhận không hợp lệ hoặc đã hết hạn.', 400)
  }
  let updated
  try {
    updated = await User.findOneAndUpdate({ _id: user._id, email: pending.originalEmail,
      passwordVersion: user.passwordVersion, 'emailChange.codeHash': hashCode(code),
      'emailChange.email': pending.email,
      'emailChange.expiresAt': { $gt: new Date() } },
    { $set: { email: pending.email, googleId: '' }, $unset: { emailChange: 1 } },
    { returnDocument: 'after', runValidators: true })
  } catch (error) {
    if (error.code === 11000) throw new ErrorResponse('Email này đã được sử dụng.', 409)
    throw error
  }
  if (!updated) throw new ErrorResponse('Yêu cầu đổi email đã thay đổi. Vui lòng thử lại.', 409)
  try {
    await sendEmail({ email: pending.originalEmail, subject: 'Cảnh báo thay đổi email LexiGrow',
      message: `Email tài khoản của bạn đã được thay đổi thành ${pending.email}. Nếu không phải bạn, hãy liên hệ bộ phận hỗ trợ.` })
  } catch (error) {
    console.error('Unable to send email change warning:', error.message)
  }
  res.status(200).json({ success: true, data: publicProfile(updated) })
})

/**
 * @desc    Change password
 * @route   PUT /api/profile/password
 * @access  Private
 */
export const changePassword = asyncHandler(async (req, res) => {
  const { currentPassword, newPassword } = req.body

  if (typeof currentPassword !== 'string' || typeof newPassword !== 'string' || !currentPassword || !newPassword) {
    throw new ErrorResponse('Please provide current and new password', 400)
  }

  const user = await User.findById(req.user._id).select('+password')
  if (!user) throw new ErrorResponse('User not found', 404)
  const isMatch = await user.matchPassword(currentPassword)

  if (!isMatch) {
    throw new ErrorResponse('Current password is incorrect', 401)
  }

  user.password = newPassword
  await user.save()
  setAuthCookie(user, res)

  res.status(200).json({ success: true, message: 'Password updated' })
})

/**
 * @desc    Update notification preferences
 * @route   PUT /api/profile/notifications
 * @access  Private
 */
export const updateNotifications = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user._id)

  // LG-38: mass-assignment guard — only whitelisted notification fields may
  // be updated (real User.notifications schema keys: email, push, weekly).
  const ALLOWED = ['email', 'push', 'weekly']
  const updates = {}
  for (const field of ALLOWED) {
    if (typeof req.body[field] === 'boolean') updates[field] = req.body[field]
  }
  user.notifications = { ...(user.notifications?.toObject?.() || user.notifications || {}), ...updates }
  await user.save()

  res.status(200).json({ success: true, data: user.notifications })
})

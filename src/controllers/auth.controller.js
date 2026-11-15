import { randomInt } from 'node:crypto'
import { OAuth2Client } from 'google-auth-library'
import User from '../models/User.js'
import PendingUser from '../models/PendingUser.js'
import ErrorResponse from '../utils/ErrorResponse.js'
import asyncHandler from '../utils/asyncHandler.js'
import sendEmail from '../utils/sendEmail.js'
import { getUserEffectiveTier } from '../services/tier.service.js'
import { normalizeEmail } from '../utils/normalizeEmail.js'
import { setAuthCookie } from '../utils/authCookie.js'
import { EMAIL_PATTERN, MAX_NAME_LENGTH, MIN_PASSWORD_LENGTH } from '../utils/accountValidation.js'

/**
 * Reject non-string body fields before they reach a Mongoose query.
 * A JSON body like { "email": { "$ne": null } } is a query object, not an
 * email, and findOne would happily match the first document.
 */
const assertStringFields = (fields, message) => {
  for (const value of Object.values(fields)) {
    if (typeof value !== 'string') {
      throw new ErrorResponse(message, 400)
    }
  }
}

/**
 * Send token response with user data
 */
const sendTokenResponse = async (user, statusCode, res) => {

  if (user.role === 'parent' && typeof user.populate === 'function') {
    await user.populate('children', 'name email avatar englishLevel')
  }

  // Remove password and sensitive reset fields from output
  const userData = user.toObject ? user.toObject() : { ...user }
  delete userData.password
  delete userData.resetPasswordCode
  delete userData.resetPasswordExpire
  delete userData.passwordVersion
  delete userData.emailChange

  try {
    const tierInfo = await getUserEffectiveTier(user)
    userData.effectiveTier = tierInfo.tier
    userData.hasPaidPlan = tierInfo.tier !== 'free'
    userData.subscriptionTier = tierInfo.tier
    userData.subscriptionSource = tierInfo.source
  } catch {
    userData.effectiveTier = 'free'
    userData.hasPaidPlan = false
    userData.subscriptionTier = 'free'
    userData.subscriptionSource = 'free'
  }
  if (typeof res.cookie === 'function') {
    setAuthCookie(user, res)
  }

  res.status(statusCode).json({
    success: true,
    user: userData,
  })
}

/**
 * @desc    Register user
 * @route   POST /api/auth/register
 * @access  Public
 */
export const register = asyncHandler(async (req, res) => {
  const { name: rawName, email: rawEmail, password, role, englishLevel, institution } = req.body || {}
  const email = normalizeEmail(rawEmail)

  assertStringFields({ name: rawName, email, password }, 'Please provide name, email and password')
  const name = rawName.trim()
  // Reject before any query, pending-record deletion, hashing or OTP delivery.
  if (!name || name.length > MAX_NAME_LENGTH) {
    throw new ErrorResponse('Name must contain between 1 and 100 characters', 400)
  }
  if (!EMAIL_PATTERN.test(email)) {
    throw new ErrorResponse('Please provide a valid email address', 400)
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new ErrorResponse('Password must be at least 6 characters', 400)
  }

  // Check if user exists in final DB
  const existingUser = await User.findOne({ email })
  if (existingUser) {
    throw new ErrorResponse('Email already registered', 400)
  }

  // Only expired registrations may be replaced. The unique email index also
  // prevents concurrent requests from inserting two live registrations.
  await PendingUser.findOneAndDelete({ email, verificationCodeExpire: { $lte: new Date() } })

  // Generate verification code
  const verificationCode = randomInt(100000, 1000000).toString()
  const verificationCodeExpire = Date.now() + 15 * 60 * 1000 // 15 mins

  // Create pending registration user
  let pendingUser
  try {
    pendingUser = await PendingUser.create({
      name,
      email,
      password, // PendingUser hashes this before saving.
      role: role || 'student',
      englishLevel: role === 'student' ? englishLevel : '',
      institution: role === 'teacher' ? institution : '',
      verificationCode,
      verificationCodeExpire,
    })
  } catch (error) {
    if (error.code === 11000) {
      throw new ErrorResponse('Email đang chờ xác thực. Thông tin đăng ký trước đó được giữ nguyên. Vui lòng nhập mã đã nhận hoặc gửi lại mã xác thực.', 409, 'REGISTRATION_PENDING')
    }
    throw error
  }

  if (process.env.NODE_ENV !== 'production') {
    console.log(`[EMAIL VERIFICATION] User: ${pendingUser.email} | Code: ${verificationCode}`)
  }

  // Send email
  try {
    const message = `Chào mừng bạn đến với LexiGrow! Mã xác thực tài khoản của bạn là: ${verificationCode}. Mã này có hiệu lực trong vòng 15 phút.`
    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; padding: 20px; border: 1px solid #e1e4e6; border-radius: 8px;">
        <h2 style="color: #005bbf; text-align: center;">Xác thực tài khoản LexiGrow</h2>
        <p>Xin chào <strong>${name}</strong>,</p>
        <p>Cảm ơn bạn đã đăng ký tài khoản tại LexiGrow. Dưới đây là mã xác thực tài khoản của bạn:</p>
        <div style="background-color: #f5f7f8; border: 1px dashed #005bbf; padding: 15px; border-radius: 6px; font-size: 24px; font-weight: bold; text-align: center; color: #005bbf; letter-spacing: 4px; margin: 20px 0;">
          ${verificationCode}
        </div>
        <p style="color: #666; font-size: 13px;">Mã xác thực này sẽ hết hạn trong vòng 15 phút. Nếu bạn không thực hiện yêu cầu này, vui lòng bỏ qua email.</p>
        <hr style="border: 0; border-top: 1px solid #eee; margin: 20px 0;" />
        <p style="text-align: center; color: #999; font-size: 12px;">LexiGrow © 2026 - Measured Writing Growth</p>
      </div>
    `
    await sendEmail({
      email: pendingUser.email,
      subject: 'Xác thực tài khoản LexiGrow',
      message,
      html,
    })

    res.status(201).json({
      success: true,
      message: 'Mã xác thực đã được gửi tới email của bạn.',
      email: pendingUser.email,
    })
  } catch (err) {
    console.error('Lỗi gửi email xác thực:', err.message)
    await PendingUser.deleteOne({ _id: pendingUser._id })
    return res.status(503).json({
      success: false,
      message: 'Không thể gửi email xác thực. Vui lòng thử lại sau.',
    })
  }
})

/**
 * @desc    Login user
 * @route   POST /api/auth/login
 * @access  Public
 */
export const login = asyncHandler(async (req, res) => {
  const { email: rawEmail, password } = req.body
  const email = normalizeEmail(rawEmail)

  // Validate. The type checks are load-bearing: a JSON body of
  // { "email": { "$ne": null }, "password": "x" } would otherwise reach
  // findOne and match an arbitrary account, admin included.
  if (!email || !password) {
    throw new ErrorResponse('Please provide email and password', 400)
  }
  if (typeof email !== 'string' || typeof password !== 'string') {
    throw new ErrorResponse('Please provide email and password', 400)
  }

  // Check user (include password for comparison)
  const user = await User.findOne({ email }).select('+password')
  if (!user) {
    throw new ErrorResponse('Invalid email or password', 401)
  }

  // Check password
  const isMatch = await user.matchPassword(password)
  if (!isMatch) {
    throw new ErrorResponse('Invalid email or password', 401)
  }

  // Check if verified
  if (user.isVerified === false) {
    throw new ErrorResponse('Email chưa được xác thực. Vui lòng xác thực trước.', 401)
  }

  // Check account status
  if (user.accountStatus === 'pending_approval') {
    throw new ErrorResponse('Tài khoản đang chờ Admin phê duyệt. Vui lòng chờ thông báo qua email.', 403)
  }
  if (user.accountStatus === 'suspended') {
    throw new ErrorResponse('Tài khoản đã bị khoá. Vui lòng liên hệ Admin để được hỗ trợ.', 403)
  }
  if (user.accountStatus === 'rejected') {
    throw new ErrorResponse('Đơn đăng ký của bạn đã bị từ chối. Vui lòng liên hệ Admin để biết thêm thông tin.', 403)
  }
  if (user.accountStatus === 'deleted') {
    throw new ErrorResponse('Account has been deleted', 403)
  }
  await sendTokenResponse(user, 200, res)
})

/**
 * @desc    Get current logged in user
 * @route   GET /api/auth/me
 * @access  Private
 */
export const getMe = asyncHandler(async (req, res) => {
  const query = User.findById(req.user._id)
  const user = await (typeof query?.select === 'function' ? query.select('-resetPasswordCode -resetPasswordExpire -passwordVersion -emailChange') : query)
  if (user && user.role === 'parent' && typeof user.populate === 'function') {
    await user.populate('children', 'name email avatar englishLevel')
  }

  const userData = user ? (user.toObject ? user.toObject() : { ...user }) : null
  if (userData) {
    delete userData.password
    delete userData.resetPasswordCode
    delete userData.resetPasswordExpire
    delete userData.passwordVersion
    delete userData.emailChange

    try {
      const tierInfo = await getUserEffectiveTier(user)
      userData.effectiveTier = tierInfo.tier
      userData.hasPaidPlan = tierInfo.tier !== 'free'
      userData.subscriptionTier = tierInfo.tier
      userData.subscriptionSource = tierInfo.source
    } catch (err) {
      userData.effectiveTier = 'free'
      userData.hasPaidPlan = false
      userData.subscriptionTier = 'free'
      userData.subscriptionSource = 'free'
    }
  }

  res.status(200).json({
    success: true,
    user: userData,
  })
})

/**
 * @desc    Google OAuth login/register (real Google OAuth code exchange)
 * @route   POST /api/auth/google
 * @access  Public
 */
export const googleAuth = asyncHandler(async (req, res) => {
  const { code, role } = req.body

  if (!code) {
    throw new ErrorResponse('Google authorization code is required', 400)
  }

  const clientId = process.env.GOOGLE_CLIENT_ID
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET

  if (!clientId || !clientSecret) {
    throw new ErrorResponse('Google OAuth is not configured on the server', 500)
  }

  const oAuth2Client = new OAuth2Client(clientId, clientSecret, 'postmessage')

  // Exchange authorization code for tokens
  let tokens
  try {
    const tokenResponse = await oAuth2Client.getToken(code)
    tokens = tokenResponse.tokens
  } catch (err) {
    console.error('Google token exchange error:', err.message)
    throw new ErrorResponse('Failed to exchange Google authorization code', 400)
  }

  // Verify the id_token to get user info
  let payload
  try {
    const ticket = await oAuth2Client.verifyIdToken({
      idToken: tokens.id_token,
      audience: clientId,
    })
    payload = ticket.getPayload()
  } catch (err) {
    console.error('Google token verification error:', err.message)
    throw new ErrorResponse('Invalid Google token', 400)
  }

  const { sub: googleId, email: rawEmail, name, picture } = payload
  const email = normalizeEmail(rawEmail)

  if (!email) {
    throw new ErrorResponse('Google account does not have an email', 400)
  }

  // Find existing user by googleId or email
  let user = await User.findOne({ $or: [{ googleId }, { email }] })

  if (user) {
    if (user.accountStatus === 'pending_approval') {
      return res.status(202).json({
        success: true,
        pendingApproval: true,
        message: 'Tài khoản giáo viên đang chờ Admin phê duyệt.',
      })
    }
    if (user.accountStatus && user.accountStatus !== 'active') {
      throw new ErrorResponse('Account is not active', 403)
    }
    // Link Google account if not already linked
    if (!user.googleId) {
      user.googleId = googleId
      if (picture) user.avatar = picture
      await user.save()
    }
  } else {
    // Validate role
    const userRole = role && ['student', 'teacher', 'parent'].includes(role) ? role : 'student'

    // Create new user with Google profile
    const userFields = {
      name: name || email.split('@')[0],
      email,
      googleId,
      avatar: picture || '',
      role: userRole,
      accountStatus: userRole === 'teacher' ? 'pending_approval' : 'active',
      englishLevel: '',
      institution: '',
      password: googleId + process.env.JWT_SECRET, // Placeholder password
      isVerified: true,
    }

    user = await User.create(userFields)
    if (user.accountStatus === 'pending_approval') {
      return res.status(202).json({
        success: true,
        pendingApproval: true,
        message: 'Tài khoản giáo viên đang chờ Admin phê duyệt.',
      })
    }
  }

  await sendTokenResponse(user, 200, res)
})

/**
 * @desc    Forgot password - send 6-digit OTP email
 * @route   POST /api/auth/forgot-password
 * @access  Public
 */
export const forgotPassword = asyncHandler(async (req, res) => {
  const { email: rawEmail } = req.body
  const email = normalizeEmail(rawEmail)

  if (!email) {
    throw new ErrorResponse('Please provide an email address', 400)
  }
  assertStringFields({ email }, 'Please provide an email address')

  const user = await User.findOne({ email })
  const acknowledge = () => res.status(200).json({
    success: true,
    message: 'Nếu email này có tài khoản, hướng dẫn đặt lại mật khẩu sẽ được gửi đến hộp thư của bạn.',
  })
  if (!user) {
    return acknowledge()
  }

  // Generate 6-digit verification code
  const code = randomInt(100000, 1000000).toString()

  user.resetPasswordCode = code
  user.resetPasswordExpire = new Date(Date.now() + 10 * 60 * 1000) // 10 minutes
  try {
    await user.save()
  } catch {
    console.error('Unable to persist password reset request')
    return acknowledge()
  }

  // SMTP latency/failure must not reveal whether the email is registered.
  // Persist the code first so a client can submit it immediately after receipt.
  acknowledge()

  const message = `Hello,\n\nYou requested a password reset. Please use the following 6-digit verification code to reset your password:\n\n${code}\n\nThis code will expire in 10 minutes.\n\nIf you did not request this, please ignore this email.\n\nBest regards,\nLexiGrow Team`

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 8px;">
      <h2 style="color: #1a73e8; text-align: center;">LexiGrow Password Reset</h2>
      <p>Hello,</p>
      <p>You requested a password reset. Please use the following 6-digit verification code to reset your password:</p>
      <div style="background-color: #f8f9fa; border: 1px dashed #1a73e8; border-radius: 4px; padding: 15px; text-align: center; font-size: 24px; font-weight: bold; letter-spacing: 5px; color: #1a73e8; margin: 20px 0;">
        ${code}
      </div>
      <p style="color: #666; font-size: 14px;">This code will expire in 10 minutes.</p>
      <p>If you did not request this, please ignore this email.</p>
      <hr style="border: 0; border-top: 1px solid #eee; margin: 20px 0;" />
      <p style="color: #999; font-size: 12px; text-align: center;">&copy; ${new Date().getFullYear()} LexiGrow. All rights reserved.</p>
    </div>
  `

  try {
    await sendEmail({
      email: user.email,
      subject: 'LexiGrow - Password Reset Verification Code',
      message,
      html,
    })

  } catch {
    console.error('Unable to deliver password reset email')
    try {
      // Never clear a newer code issued by a concurrent request.
      await User.updateOne({ _id: user._id, resetPasswordCode: code },
        { $unset: { resetPasswordCode: 1, resetPasswordExpire: 1 } })
    } catch {
      console.error('Unable to clear undelivered password reset code')
    }
  }
})

/**
 * @desc    Reset password using verification code
 * @route   POST /api/auth/reset-password
 * @access  Public
 */
export const resetPassword = asyncHandler(async (req, res) => {
  const { email: rawEmail, code, newPassword } = req.body
  const email = normalizeEmail(rawEmail)

  if (!email || !code || !newPassword) {
    throw new ErrorResponse('Please provide email, verification code, and new password', 400)
  }
  // Type checks are load-bearing: without them a body of
  // { "email": { "$ne": null }, "code": { "$ne": "" } } matches any account
  // currently inside the reset flow and takes it over without knowing the code.
  assertStringFields({ email, code, newPassword }, 'Please provide email, verification code, and new password')

  const query = User.findOne({
    email,
    resetPasswordCode: code,
    resetPasswordExpire: { $gt: Date.now() },
  })
  const user = await (typeof query?.select === 'function'
    ? query.select('+password +resetPasswordCode +resetPasswordExpire')
    : query)

  if (!user) {
    throw new ErrorResponse('Invalid or expired verification code', 400)
  }

  // Set new password (will be hashed automatically on save)
  user.password = newPassword
  user.resetPasswordCode = ''
  user.resetPasswordExpire = undefined
  await user.save()

  res.status(200).json({
    success: true,
    message: 'Password reset successful. You can now login with your new password.',
  })
})

/**
 * @desc    Get auth configuration (e.g., Google Client ID)
 * @route   GET /api/auth/config
 * @access  Public
 */
export const getAuthConfig = asyncHandler(async (req, res) => {
  res.status(200).json({
    success: true,
    googleClientId: process.env.GOOGLE_CLIENT_ID || '',
  })
})

/**
 * @desc    Acknowledge an email without revealing registration status
 * @route   POST /api/auth/check-email
 * @access  Public
 */
export const checkEmail = asyncHandler(async (req, res) => {
  const { email: rawEmail } = req.body
  const email = normalizeEmail(rawEmail)

  if (!email) {
    throw new ErrorResponse('Please provide an email', 400)
  }
  assertStringFields({ email }, 'Please provide an email')

  res.status(200).json({
    success: true,
    message: 'Vui lòng tiếp tục đăng nhập hoặc đăng ký để sử dụng tài khoản.',
  })
})

/**
 * @desc    Verify email with 6-digit code
 * @route   POST /api/auth/verify-email
 * @access  Public
 */
export const verifyEmail = asyncHandler(async (req, res) => {
  const { email: rawEmail, code } = req.body
  const email = normalizeEmail(rawEmail)

  if (!email || !code) {
    throw new ErrorResponse('Vui lòng cung cấp email và mã xác thực', 400)
  }
  assertStringFields({ email, code }, 'Vui lòng cung cấp email và mã xác thực')

  // Check if user is already verified and in final collection
  const existingUser = await User.findOne({ email })
  if (existingUser) {
    return res.status(200).json({
      success: true,
      message: 'Email đã được xác thực trước đó.'
    })
  }

  // Find pending user
  const pending = await PendingUser.findOne({ email, verificationCode: code })
  if (!pending) {
    throw new ErrorResponse('Mã xác thực không chính xác', 400)
  }

  if (pending.verificationCodeExpire < new Date()) {
    throw new ErrorResponse('Mã xác thực đã hết hạn', 400)
  }

  // Set accountStatus based on role:
  // - student → active immediately
  // - teacher → pending_approval (requires Admin review)
  // Parent-child relationships are verified separately with one-time link codes.
  const requiresApproval = pending.role === 'teacher'
  const userFields = {
    name: pending.name,
    email: pending.email,
    password: pending.password,
    role: pending.role,
    englishLevel: pending.englishLevel,
    institution: pending.institution,
    isVerified: true,
    accountStatus: requiresApproval ? 'pending_approval' : 'active',
  }

  const user = pending.passwordHashed
    ? await User.createWithPasswordHash(userFields)
    : await User.create(userFields) // Legacy pending registrations still contain plaintext.

  // Delete pending document
  await PendingUser.deleteOne({ _id: pending._id })

  if (requiresApproval) {
    // Teachers must wait for Admin approval — do NOT issue a token
    return res.status(202).json({
      success: true,
      pendingApproval: true,
      message: 'Email đã được xác thực thành công. Tài khoản của bạn đang chờ Admin phê duyệt. Bạn sẽ nhận được thông báo qua email khi được duyệt.',
    })
  }

  await sendTokenResponse(user, 200, res)
})

/**
 * @desc    Resend verification code
 * @route   POST /api/auth/resend-verify
 * @access  Public
 */
export const resendVerification = asyncHandler(async (req, res) => {
  const { email: rawEmail } = req.body
  const email = normalizeEmail(rawEmail)

  if (!email) {
    throw new ErrorResponse('Vui lòng cung cấp email', 400)
  }
  assertStringFields({ email }, 'Vui lòng cung cấp email')

  // Check if verified in final DB
  const existingUser = await User.findOne({ email })
  if (existingUser) {
    throw new ErrorResponse('Email đã được xác thực', 400)
  }

  // Find in pending users
  const pending = await PendingUser.findOne({ email })
  if (!pending) {
    throw new ErrorResponse('Không tìm thấy thông tin đăng ký tạm cho email này', 404)
  }

  const verificationCode = randomInt(100000, 1000000).toString()
  pending.verificationCode = verificationCode
  pending.verificationCodeExpire = Date.now() + 15 * 60 * 1000
  await pending.save()

  if (process.env.NODE_ENV !== 'production') {
    console.log(`[EMAIL VERIFICATION RESEND] User: ${pending.email} | Code: ${verificationCode}`)
  }

  try {
    const message = `Mã xác thực mới của bạn là: ${verificationCode}. Mã này có hiệu lực trong vòng 15 phút.`
    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; padding: 20px; border: 1px solid #e1e4e6; border-radius: 8px;">
        <h2 style="color: #005bbf; text-align: center;">Xác thực tài khoản LexiGrow</h2>
        <p>Xin chào <strong>${pending.name}</strong>,</p>
        <p>Dưới đây là mã xác thực tài khoản mới của bạn:</p>
        <div style="background-color: #f5f7f8; border: 1px dashed #005bbf; padding: 15px; border-radius: 6px; font-size: 24px; font-weight: bold; text-align: center; color: #005bbf; letter-spacing: 4px; margin: 20px 0;">
          ${verificationCode}
        </div>
        <p style="color: #666; font-size: 13px;">Mã xác thực này sẽ hết hạn trong vòng 15 phút. Nếu bạn không thực hiện yêu cầu này, vui lòng bỏ qua email.</p>
        <hr style="border: 0; border-top: 1px solid #eee; margin: 20px 0;" />
        <p style="text-align: center; color: #999; font-size: 12px;">LexiGrow © 2026 - Measured Writing Growth</p>
      </div>
    `
    await sendEmail({
      email: pending.email,
      subject: 'Xác thực tài khoản LexiGrow (Gửi lại)',
      message,
      html,
    })

    res.status(200).json({
      success: true,
      message: 'Mã xác thực đã được gửi lại tới email của bạn.'
    })
  } catch (err) {
    console.error('Lỗi gửi lại email xác thực:', err.message)
    return res.status(503).json({
      success: false,
      message: 'Không thể gửi email xác thực. Vui lòng thử lại sau.',
    })
  }
})

/**
 * @desc    Log user out / clear cookie
 * @route   POST /api/auth/logout
 * @access  Public
 */
export const logout = asyncHandler(async (req, res) => {
  if (typeof res.cookie === 'function') {
    res.cookie('token', 'none', {
      expires: new Date(Date.now() + 5 * 1000),
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: process.env.NODE_ENV === 'production' ? 'strict' : 'lax',
      path: '/',
    })
  }
  res.status(200).json({
    success: true,
    message: 'User logged out successfully',
    data: {},
  })
})




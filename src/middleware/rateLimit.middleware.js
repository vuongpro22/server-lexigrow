import rateLimit, { ipKeyGenerator } from 'express-rate-limit'

const FIFTEEN_MINUTES = 15 * 60 * 1000

const baseOptions = {
  windowMs: FIFTEEN_MINUTES,
  standardHeaders: true,
  legacyHeaders: false,
}

// Bound email probing across many addresses from the same client.
export const publicEmailLimiter = rateLimit({
  ...baseOptions,
  limit: 30,
  message: { success: false, message: 'Quá nhiều yêu cầu. Vui lòng thử lại sau 15 phút.' },
})

// Profile routes run after protect. Count by account, including successful
// email-change requests, to bound mail sends and OTP guessing across IPs.
export const emailChangeRequestLimiter = rateLimit({
  ...baseOptions,
  limit: 5,
  keyGenerator: req => String(req.user._id),
  skip: req => req.body.email === undefined || (typeof req.body.email === 'string'
    && req.body.email.trim().toLowerCase() === req.user.email),
  message: { success: false, message: 'Quá nhiều yêu cầu đổi email. Vui lòng thử lại sau 15 phút.' },
})

export const emailChangeVerifyLimiter = rateLimit({
  ...baseOptions,
  limit: 10,
  keyGenerator: req => String(req.user._id),
  message: { success: false, message: 'Quá nhiều lần xác nhận email. Vui lòng thử lại sau 15 phút.' },
})

/**
 * 10 requests / 15 minutes / IP — registration endpoint.
 */
export const authRegisterLimiter = rateLimit({
  ...baseOptions,
  limit: 10,
  message: {
    success: false,
    message: 'Quá nhiều yêu cầu đăng ký. Vui lòng thử lại sau 15 phút.',
  },
})

/**
 * 10 failed requests / 15 minutes / IP — login endpoint.
 * Successful logins are not counted (skipSuccessfulRequests).
 */
export const authLoginLimiter = rateLimit({
  ...baseOptions,
  limit: 10,
  skipSuccessfulRequests: true,
  message: {
    success: false,
    message: 'Quá nhiều lần đăng nhập thất bại. Vui lòng thử lại sau 15 phút.',
  },
})

/**
 * 10 requests / 15 minutes / IP — OTP verification (brute-force protection for 6-digit codes).
 */
export const authVerifyLimiter = rateLimit({
  ...baseOptions,
  limit: 10,
  message: {
    success: false,
    message: 'Quá nhiều yêu cầu xác thực. Vui lòng thử lại sau 15 phút.',
  },
})

/**
 * 3 requests / 15 minutes / EMAIL — resend verification / forgot password.
 * Falls back to the client IP when the email is absent from the body.
 */
export const authResendLimiter = rateLimit({
  ...baseOptions,
  limit: 3,
  keyGenerator: (req) => {
    const email =
      typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : ''
    return email || ipKeyGenerator(req.ip || '127.0.0.1')
  },
  message: {
    success: false,
    message: 'Quá nhiều yêu cầu gửi lại mã. Vui lòng thử lại sau 15 phút.',
  },
})

/**
 * 300 requests / minute / ADMIN USER — every /api/admin route.
 *
 * Keyed by user id, not IP: admins routinely sit behind one office NAT, so an
 * IP ceiling would throttle colleagues whenever one of them bulk-browses. The
 * limit is deliberately high because the admin UI polls several panels at once
 * (dashboard stats, AI monitoring, approvals), and the point is only to stop a
 * runaway script or a leaked token from hammering the API, not to shape traffic.
 *
 * mountRateLimit runs AFTER protect, so req.user is always present.
 */
export const adminLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 300,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => String(req.user?._id || ipKeyGenerator(req.ip || '127.0.0.1')),
  message: {
    success: false,
    message: 'Quá nhiều yêu cầu quản trị. Vui lòng thử lại sau ít phút.',
  },
})

/**
 * 100 requests / minute / IP — PayOS webhook.
 * PayOS retries quickly on transient failures, so the ceiling is kept generous
 * to avoid dropping legitimate retries.
 */
export const payosWebhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 100,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => ipKeyGenerator(req.ip || '127.0.0.1'),
  message: {
    success: false,
    message: 'Quá nhiều yêu cầu webhook. Vui lòng thử lại sau.',
  },
})

import jwt from 'jsonwebtoken'
import User from '../models/User.js'
import ErrorResponse from '../utils/ErrorResponse.js'
import asyncHandler from '../utils/asyncHandler.js'
if (!process.env.JWT_SECRET) {
  throw new Error('FATAL: JWT_SECRET is not configured')
}

const hasStalePasswordVersion = (decoded, user) => decoded.passwordVersion === undefined
  ? (user.passwordVersion || 0) > 1
  : decoded.passwordVersion !== (user.passwordVersion || 0)


/**
 * Protect routes — verify JWT token
 */
export const protect = asyncHandler(async (req, res, next) => {
  let token

  if (req.cookies?.token && req.cookies.token !== 'none') {
    token = req.cookies.token
  } else if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
    token = req.headers.authorization.split(' ')[1]
  }

  if (!token) {
    throw new ErrorResponse('Not authorized to access this route', 401)
  }

  const decoded = jwt.verify(token, process.env.JWT_SECRET)
  req.user = await User.findById(decoded.id)

  if (!req.user) {
    throw new ErrorResponse('User not found', 401)
  }
  if (hasStalePasswordVersion(decoded, req.user)) {
    throw new ErrorResponse('Session expired after password change', 401)
  }
  if (req.user.accountStatus && req.user.accountStatus !== 'active') {
    throw new ErrorResponse('Account is not active', 403)
  }

  next()
})

/**
 * Authorize by role
 */
export const authorize = (...roles) => {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      throw new ErrorResponse(`Role '${req.user.role}' is not authorized to access this route`, 403)
    }
    next()
  }
}


/**
 * Optional authentication — populates req.user if valid token present, but doesn't block guests
 */
export const optionalAuth = asyncHandler(async (req, res, next) => {
  let token

  if (req.cookies?.token && req.cookies.token !== 'none') {
    token = req.cookies.token
  } else if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
    token = req.headers.authorization.split(' ')[1]
  }

  if (token) {
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET)
      const user = await User.findById(decoded.id)
      if (user
        && !hasStalePasswordVersion(decoded, user)
        && (!user.accountStatus || user.accountStatus === 'active')) {
        req.user = user
      }
    } catch {
      // Continue as guest if token is invalid or expired
    }
  }

  next()
})

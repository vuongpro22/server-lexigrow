import ErrorResponse from '../utils/ErrorResponse.js'

/**
 * Global error handling middleware
 */
const errorHandler = (err, req, res, next) => {
  void next
  let error = { ...err }
  error.message = err.message

  // Mongoose bad ObjectId -> 404 Client Error
  if (err.name === 'CastError') {
    const message = 'Resource not found'
    error = new ErrorResponse(message, 404)
  }

  // Mongoose duplicate key -> 400 Client Error
  if (err.code === 11000) {
    const field = Object.keys(err.keyValue || {})[0] || 'resource'
    const message = `Duplicate value for field: ${field}`
    error = new ErrorResponse(message, 400)
  }

  // Mongoose validation error -> 400 Client Error
  if (err.name === 'ValidationError') {
    const message = Object.values(err.errors).map((val) => val.message).join(', ')
    error = new ErrorResponse(message, 400)
  }

  // JWT errors -> 401 Client Error
  if (err.name === 'JsonWebTokenError') {
    error = new ErrorResponse('Invalid token', 401)
  }

  if (err.name === 'TokenExpiredError') {
    error = new ErrorResponse('Token expired', 401)
  }

  // Version error -> 409 Client Conflict
  if (err.name === 'VersionError') {
    error = new ErrorResponse('Resource changed; reload and retry', 409)
  }

  const statusCode = error.statusCode || err.statusCode || 500

  // Controlled error logging based on normalized status code
  if (statusCode >= 500) {
    if (process.env.NODE_ENV === 'production') {
      // In production, log controlled diagnostic info without leaking raw err object or stack trace
      console.error(`[SERVER ERROR] ${req?.method || ''} ${req?.originalUrl || ''} - Status: ${statusCode} - ${err?.name || 'Error'}`)
    } else {
      console.error('❌ Server Error:', err.message || err)
    }
  } else if (process.env.NODE_ENV === 'development') {
    console.warn(`⚠️ Client Error (${statusCode}): ${error.message}`)
  }

  // 5xx responses never echo the error message: it can carry connection strings,
  // bearer headers or query fragments. The structured code stays so clients can
  // branch on it, but many codes (ECONNREFUSED, ETIMEDOUT) are also raised by
  // infrastructure errors whose messages are exactly the sensitive ones.
  if (statusCode >= 500) {
    const errorCode = err.code || error.code
    const errorBody = { success: false, error: 'Server Error' }
    if (errorCode) errorBody.code = errorCode
    return res.status(statusCode).json(errorBody)
  }

  const responsePayload = {
    success: false,
    error: error.message || 'Client Error',
  }
  const code = err.code || error.code
  if (code) {
    responsePayload.code = code
    responsePayload.errorCode = err.errorCode || error.errorCode || code
    if (code === 'DAILY_ESSAY_LIMIT_REACHED' || code === 'DAILY_AI_QUOTA_EXCEEDED') {
      responsePayload.errorCode = 'DAILY_ESSAY_LIMIT_REACHED'
    }
  }

  if (err.limit !== undefined || error.limit !== undefined) {
    responsePayload.limit = err.limit ?? error.limit
  } else if (typeof (err.message || error.message) === 'string') {
    const limitMatch = (err.message || error.message).match(/limit reached \((\d+)\)/i)
    if (limitMatch) {
      responsePayload.limit = parseInt(limitMatch[1], 10)
    }
  }
  if (err.tier !== undefined || error.tier !== undefined) {
    responsePayload.tier = err.tier ?? error.tier
  }

  res.status(statusCode).json(responsePayload)
}

export default errorHandler

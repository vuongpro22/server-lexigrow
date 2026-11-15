import ErrorResponse from './ErrorResponse.js'

export const normalizeEmail = value => {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ErrorResponse('Please provide a valid email address', 400)
  }
  return value.trim().toLowerCase()
}

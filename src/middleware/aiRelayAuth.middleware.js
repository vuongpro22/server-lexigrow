import crypto from 'node:crypto'
import ErrorResponse from '../utils/ErrorResponse.js'

function normalizeIp(ip) {
  return String(ip || '').replace(/^::ffff:/, '')
}

// Fail-closed: an unset or empty allowlist denies every relay call rather than
// quietly accepting all source IPs.
export function parseRelayAllowlist(value = process.env.AI_RELAY_ALLOWED_IPS) {
  return String(value || '')
    .split(',')
    .map((entry) => normalizeIp(entry.trim()))
    .filter(Boolean)
}

export function requireAIRelayService(req, res, next) {
  const expected = process.env.AI_RELAY_SERVICE_TOKEN
  if (!expected) return next(new ErrorResponse('AI relay is not configured', 503))

  const allowlist = parseRelayAllowlist()
  if (!allowlist.length) return next(new ErrorResponse('AI relay is not configured', 503))
  if (!allowlist.includes(normalizeIp(req.ip))) {
    return next(new ErrorResponse('Invalid AI relay credentials', 403))
  }

  const provided = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '')
  const digest = (value) => crypto.createHash('sha256').update(value).digest()
  if (!provided || !crypto.timingSafeEqual(digest(provided), digest(expected))) {
    return next(new ErrorResponse('Invalid AI relay credentials', 403))
  }
  next()
}

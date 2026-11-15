import rateLimit from 'express-rate-limit'
import { RedisStore } from 'rate-limit-redis'
import { ensureRedisReady, getRedisClient, redisConfigured } from '../services/redisClient.js'

// Fail-closed store: a limit that cannot be counted must not be treated as
// "under the limit", so a Redis outage rejects the request instead of quietly
// letting every instance keep its own in-memory counter.
class FailClosedRedisStore {
  constructor(prefix) {
    this.prefix = prefix
    this.inner = null
  }

  // rate-limit-redis loads its Lua scripts from the constructor, so the store can
  // only be built once a connection is known-good.
  async store() {
    if (!(await ensureRedisReady())) throw new Error('AI rate limit store is unavailable')
    if (!this.inner) {
      this.inner = new RedisStore({ prefix: this.prefix, sendCommand: (...args) => getRedisClient().sendCommand(args) })
    }
    return this.inner
  }

  async init() {
    // Real initialization happens on the first increment so a dead Redis does not
    // raise an unhandled script-load rejection during module load.
  }

  async increment(key) {
    return (await this.store()).increment(key)
  }

  async decrement(key) {
    return this.inner ? this.inner.decrement(key) : undefined
  }

  async resetKey(key) {
    return this.inner ? this.inner.resetKey(key) : undefined
  }
}

const storeFor = (prefix) => (redisConfigured() ? new FailClosedRedisStore(prefix) : undefined)

// A Redis outage must surface as 503, not a generic 500 from the error handler.
const failClosed = (limiter) => (req, res, next) => {
  limiter(req, res, (err) => {
    if (!err) return next()
    if (!redisConfigured()) return next(err)
    console.error('[AI Rate Limit] Store unavailable:', err.message)
    res.status(503).json({
      success: false,
      error: 'AI request limit is temporarily unavailable. Please retry later.',
    })
  })
}

export const createAiLimiter = (options = {}) =>
  failClosed(rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 20,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: (req) => String(req.user._id),
    store: storeFor('ai-learning:'),
    passOnStoreError: false,
    message: {
      success: false,
      error: 'AI request limit reached. Please retry later.',
    },
    ...options,
  }))
export const aiLearningLimiter = createAiLimiter()
export const aiRelayLimiter = failClosed(rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  store: storeFor('ai-relay:'),
  // Redis is required once configured: never fall back to per-instance counters.
  passOnStoreError: false,
  message: { success: false, error: 'AI relay request limit reached. Please retry later.' },
}))

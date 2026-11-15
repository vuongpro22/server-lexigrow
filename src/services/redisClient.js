import { createClient } from 'redis'

let client = null

export const redisConfigured = () => Boolean(process.env.REDIS_URL)

export function getRedisClient() {
  if (!client) {
    client = createClient({
      url: process.env.REDIS_URL,
      // A shared limiter must fail fast: never retry forever behind a dead Redis.
      socket: { connectTimeout: 2000, reconnectStrategy: () => false },
    })
    client.on('error', (err) => console.error('[Redis] Client error:', err.message))
  }
  return client
}

// Connects on first use. Returns false rather than throwing so callers can fail
// closed with a clear 503 instead of leaking a stack trace.
export async function ensureRedisReady() {
  if (!redisConfigured()) return false
  const redis = getRedisClient()
  if (redis.isReady) return true
  try {
    if (!redis.isOpen) await redis.connect()
    return redis.isReady
  } catch (err) {
    console.error('[Redis] Connection failed:', err.message)
    // A failed client stays half-open and throws "The client is closed" on every
    // later command, so drop it; the next call rebuilds one.
    try { redis.destroy() } catch { /* already torn down */ }
    if (client === redis) client = null
    return false
  }
}

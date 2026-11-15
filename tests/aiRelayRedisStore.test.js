import { afterEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'

// REDIS_URL must be set before the limiter module builds its store.
const buildApp = async (redisUrl) => {
  if (redisUrl) process.env.REDIS_URL = redisUrl
  else delete process.env.REDIS_URL
  vi.resetModules()
  const { aiRelayLimiter } = await import('../src/middleware/learningRateLimit.js')
  const app = express()
  app.use(express.json())
  app.post('/internal/ai/v1/complete', aiRelayLimiter, (req, res) => res.json({ success: true }))
  return app
}

afterEach(async () => {
  // Disconnect quietly; the store keeps a module-level client that must not leak
  // an open socket into the next import.
  const { getRedisClient } = await import('../src/services/redisClient.js')
  const client = getRedisClient()
  if (client?.isOpen) client.destroy()
  delete process.env.REDIS_URL
})

describe('AI relay limiter with a shared Redis store', () => {
  it('fails closed with 503 when the configured Redis store is unreachable', async () => {
    const app = await buildApp('redis://127.0.0.1:6399')
    const res = await request(app).post('/internal/ai/v1/complete').send({})
    expect(res.status).toBe(503)
    expect(res.body.success).toBe(false)
    expect(res.body.error).toContain('temporarily unavailable')
  }, 30000)

  it('keeps the in-memory limiter when no Redis URL is configured', async () => {
    const app = await buildApp(undefined)
    delete process.env.REDIS_URL
    await request(app).post('/internal/ai/v1/complete').send({}).expect(200)
  })
})

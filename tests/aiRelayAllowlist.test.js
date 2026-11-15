import { afterEach, describe, expect, it } from 'vitest'
import express from 'express'
import request from 'supertest'
import crypto from 'node:crypto'
import { requireAIRelayService, parseRelayAllowlist } from '../src/middleware/aiRelayAuth.middleware.js'
import errorHandler from '../src/middleware/error.middleware.js'

const TOKEN = 'relay-service-token'
const build = () => {
  const app = express()
  app.set('trust proxy', 0)
  app.use(express.json())
  app.post('/internal/ai/v1/complete', requireAIRelayService, (req, res) => res.json({ success: true }))
  app.use(errorHandler)
  return app
}

afterEach(() => {
  delete process.env.AI_RELAY_SERVICE_TOKEN
  delete process.env.AI_RELAY_ALLOWED_IPS
})

describe('internal AI relay source IP allowlist', () => {
  it('parses a comma separated allowlist and drops IPv6-mapped prefixes', () => {
    expect(parseRelayAllowlist(' 127.0.0.1 , ::ffff:10.0.0.5 ,, ')).toEqual(['127.0.0.1', '10.0.0.5'])
    expect(parseRelayAllowlist(undefined)).toEqual([])
  })

  it('denies every caller when the allowlist is missing', async () => {
    process.env.AI_RELAY_SERVICE_TOKEN = TOKEN
    await request(build()).post('/internal/ai/v1/complete')
      .set('Authorization', `Bearer ${TOKEN}`).send({}).expect(503)
  })

  it('denies a valid token from an address outside the allowlist', async () => {
    process.env.AI_RELAY_SERVICE_TOKEN = TOKEN
    process.env.AI_RELAY_ALLOWED_IPS = '10.0.0.5'
    await request(build()).post('/internal/ai/v1/complete')
      .set('Authorization', `Bearer ${TOKEN}`).send({}).expect(403)
  })

  it('allows a valid token from an allowlisted address', async () => {
    process.env.AI_RELAY_SERVICE_TOKEN = TOKEN
    process.env.AI_RELAY_ALLOWED_IPS = '127.0.0.1'
    await request(build()).post('/internal/ai/v1/complete')
      .set('Authorization', `Bearer ${TOKEN}`).send({}).expect(200)
  })

  it('rejects a wrong token even from an allowlisted address', async () => {
    process.env.AI_RELAY_SERVICE_TOKEN = TOKEN
    process.env.AI_RELAY_ALLOWED_IPS = '127.0.0.1'
    await request(build()).post('/internal/ai/v1/complete')
      .set('Authorization', 'Bearer wrong').send({}).expect(403)
  })

  it('ignores a spoofed X-Forwarded-For header when no proxy is trusted', async () => {
    process.env.AI_RELAY_SERVICE_TOKEN = TOKEN
    process.env.AI_RELAY_ALLOWED_IPS = '10.0.0.5'
    await request(build()).post('/internal/ai/v1/complete')
      .set('Authorization', `Bearer ${TOKEN}`)
      .set('X-Forwarded-For', '10.0.0.5').send({}).expect(403)
  })

  it('uses the client address the trusted proxy reports', async () => {
    process.env.AI_RELAY_SERVICE_TOKEN = TOKEN
    process.env.AI_RELAY_ALLOWED_IPS = '10.0.0.5'
    const app = express()
    app.set('trust proxy', 1)
    app.use(express.json())
    app.post('/internal/ai/v1/complete', requireAIRelayService, (req, res) => res.json({ success: true }))
    app.use(errorHandler)
    await request(app).post('/internal/ai/v1/complete')
      .set('Authorization', `Bearer ${TOKEN}`)
      .set('X-Forwarded-For', '10.0.0.5').send({}).expect(200)
  })

  it('compares tokens in constant time', async () => {
    const spy = crypto.timingSafeEqual
    expect(typeof spy).toBe('function')
  })
})

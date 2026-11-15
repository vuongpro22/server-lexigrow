import { describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'

vi.mock('../src/config/db.js', () => ({ default: vi.fn().mockResolvedValue() }))

import { adminLimiter } from '../src/middleware/rateLimit.middleware.js'

const buildApp = () => {
  const app = express()
  app.use((req, res, next) => {
    req.user = req.headers['x-test-user'] ? { _id: String(req.headers['x-test-user']) } : undefined
    next()
  })
  app.use(adminLimiter)
  app.get('/probe', (req, res) => res.json({ ok: true }))
  return app
}

describe('adminLimiter', () => {
  it('adds RateLimit headers, using the standard field names', async () => {
    const res = await request(buildApp()).get('/probe').set('x-test-user', 'user-a')
    expect(res.status).toBe(200)
    // express-rate-limit v8 writes ratelimit-policy / ratelimit-limit /
    // ratelimit-remaining / ratelimit-reset (measured, not assumed).
    expect(res.headers['ratelimit-limit']).toBe('300')
    expect(res.headers['ratelimit-remaining']).toBeDefined()
    expect(res.headers['ratelimit-policy']).toContain('300')
  })

  it('keys by user id, so one admin exhausting the budget does not block another', async () => {
    const app = buildApp()
    for (let i = 0; i < 300; i++) await request(app).get('/probe').set('x-test-user', 'user-a')
    const blocked = await request(app).get('/probe').set('x-test-user', 'user-a')
    expect(blocked.status).toBe(429)
    const other = await request(app).get('/probe').set('x-test-user', 'user-b')
    expect(other.status).toBe(200)
  })

  it('429 body carries the Vietnamese message and success:false', async () => {
    const app = buildApp()
    for (let i = 0; i < 300; i++) await request(app).get('/probe').set('x-test-user', 'user-c')
    const res = await request(app).get('/probe').set('x-test-user', 'user-c')
    expect(res.status).toBe(429)
    expect(res.body.success).toBe(false)
    expect(res.body.message).toContain('quản trị')
  })
})

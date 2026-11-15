import { expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'

const state = vi.hoisted(() => ({ complete: vi.fn(), auth: vi.fn((req, res, next) => next()) }))
vi.mock('../src/middleware/aiRelayAuth.middleware.js', () => ({ requireAIRelayService: state.auth }))
vi.mock('../src/controllers/internalAiRelay.controller.js', () => ({ completeInternalAI: state.complete }))

import relayRoutes from '../src/routes/internalAiRelay.routes.js'

it('limits relay traffic after the service-token middleware', async () => {
  state.complete.mockImplementation((req, res) => res.json({ success: true }))
  const app = express()
  app.use(express.json())
  app.use('/internal/ai/v1', relayRoutes)
  for (let i = 0; i < 120; i++) await request(app).post('/internal/ai/v1/complete').send({}).expect(200)
  const limited = await request(app).post('/internal/ai/v1/complete').send({}).expect(429)
  expect(limited.body.success).toBe(false)
  expect(state.auth).toHaveBeenCalledTimes(121)
  expect(state.complete).toHaveBeenCalledTimes(120)
})

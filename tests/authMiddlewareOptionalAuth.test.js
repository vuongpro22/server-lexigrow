import { beforeEach, describe, expect, it, vi } from 'vitest'
import jwt from 'jsonwebtoken'

const { findById } = vi.hoisted(() => {
  process.env.JWT_SECRET ||= 'optional-auth-middleware-test-secret'
  return { findById: vi.fn() }
})

vi.mock('../src/models/User.js', () => ({
  default: { findById },
}))

import { optionalAuth, protect } from '../src/middleware/auth.middleware.js'

const makeRequest = (token) => ({ cookies: { token }, headers: {} })

const invoke = async (middleware, req) => {
  const next = vi.fn()
  await middleware(req, {}, next)
  return next
}

describe('password-version revocation in auth middleware', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('rejects a changed-password token on protected routes and treats it as a guest on public routes', async () => {
    const user = { _id: 'student-1', passwordVersion: 4, accountStatus: 'active' }
    findById.mockResolvedValue(user)
    const staleToken = jwt.sign({ id: user._id, passwordVersion: 3 }, process.env.JWT_SECRET)

    const protectedNext = await invoke(protect, makeRequest(staleToken))
    expect(protectedNext).toHaveBeenCalledTimes(1)
    expect(protectedNext).toHaveBeenCalledWith(expect.objectContaining({
      message: 'Session expired after password change',
      statusCode: 401,
    }))

    const publicRequest = makeRequest(staleToken)
    const optionalNext = await invoke(optionalAuth, publicRequest)
    expect(optionalNext).toHaveBeenCalledTimes(1)
    expect(optionalNext).toHaveBeenCalledWith()
    expect(publicRequest.user).toBeUndefined()
  })

  it('continues to populate req.user for a valid logged-in user', async () => {
    const user = { _id: 'student-1', passwordVersion: 4, accountStatus: 'active' }
    findById.mockResolvedValue(user)
    const validToken = jwt.sign({ id: user._id, passwordVersion: 4 }, process.env.JWT_SECRET)
    const request = makeRequest(validToken)

    const next = await invoke(optionalAuth, request)

    expect(next).toHaveBeenCalledTimes(1)
    expect(next).toHaveBeenCalledWith()
    expect(request.user).toBe(user)
  })
})

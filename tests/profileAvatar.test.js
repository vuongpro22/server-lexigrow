import { beforeEach, expect, it, vi } from 'vitest'
import { getProfile, updateProfile } from '../src/controllers/profile.controller.js'

const { findById } = vi.hoisted(() => ({ findById: vi.fn() }))
vi.mock('../src/models/User.js', () => ({ default: { findById } }))

let user
beforeEach(() => {
  vi.resetAllMocks()
  user = { _id: 'teacher-1', avatar: 'https://example.com/old.png', save: vi.fn().mockResolvedValue() }
  findById.mockResolvedValue(user)
})
const response = () => ({ status: vi.fn().mockReturnThis(), json: vi.fn() })
const request = body => ({ user: { _id: 'teacher-1' }, body })

it('saves an avatar on the current user and returns it when loading profile', async () => {
  const avatar = 'data:image/png;base64,aW1hZ2U='
  const next = vi.fn()
  await updateProfile(request({ avatar }), response(), next)
  expect(next).not.toHaveBeenCalled()
  expect(user.save).toHaveBeenCalledOnce()
  expect(user.avatar).toBe(avatar)
  expect(findById).toHaveBeenCalledWith('teacher-1')
  const res = response()
  await getProfile(request({}), res, next)
  expect(res.json).toHaveBeenCalledWith({ success: true, data: expect.objectContaining({ avatar }) })
})

it.each([undefined, 'https://example.com/old.png'])('preserves existing avatars when omitted or unchanged', async avatar => {
  const next = vi.fn()
  await updateProfile(request({ name: 'Updated teacher', avatar }), response(), next)
  expect(next).not.toHaveBeenCalled()
  expect(user.avatar).toBe('https://example.com/old.png')
  expect(user.save).toHaveBeenCalledOnce()
})

it.each([
  null, {}, 'data:image/svg+xml;base64,PHN2Zz4=', 'data:image/png;base64,invalid!',
  `data:image/png;base64,${Buffer.alloc(2 * 1024 * 1024 + 1).toString('base64')}`,
])('rejects invalid or oversized avatars without saving', async avatar => {
  const next = vi.fn()
  await updateProfile(request({ avatar }), response(), next)
  expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }))
  expect(user.save).not.toHaveBeenCalled()
  expect(user.avatar).toBe('https://example.com/old.png')
})

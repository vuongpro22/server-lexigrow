import { vi } from 'vitest'

export const mockQuery = (val) => {
  const q = {
    sort: vi.fn().mockImplementation(() => q),
    skip: vi.fn().mockImplementation(() => q),
    limit: vi.fn().mockImplementation(() => q),
    populate: vi.fn().mockImplementation(() => q),
    select: vi.fn().mockImplementation(() => q),
    then: (resolve) => resolve(val),
    catch: () => {}
  }
  return q
}

export const createMockContext = (options = {}) => {
  const req = {
    body: options.body || {},
    params: options.params || {},
    query: options.query || {},
    user: options.user || { _id: 'student_1', role: 'student', name: 'Student One' }
  }
  const res = {
    statusCode: 200,
    status: vi.fn().mockImplementation(function (code) {
      this.statusCode = code
      return this
    }),
    json: vi.fn().mockImplementation(function (data) {
      this.data = data
      return this
    })
  }
  const next = vi.fn()
  return { req, res, next }
}

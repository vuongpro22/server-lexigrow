import { describe, expect, it } from 'vitest'
import User from '../src/models/User.js'
import Class from '../src/models/Class.js'

// A-H13: admin user list filters on accountStatus + role and sorts by createdAt;
// the class list scopes by teacher. Without these indexes both are collection scans.
const hasIndexOn = (schema, keys) => {
  const wanted = JSON.stringify(keys)
  return schema.indexes().some(([fields]) => JSON.stringify(fields) === wanted)
}

describe('model indexes backing the admin list queries', () => {
  it('users has a compound index for accountStatus + role + createdAt', () => {
    expect(hasIndexOn(User.schema, { accountStatus: 1, role: 1, createdAt: -1 })).toBe(true)
  })

  it('classes has an index for teacher + status + createdAt', () => {
    expect(hasIndexOn(Class.schema, { teacher: 1, status: 1, createdAt: -1 })).toBe(true)
  })

  it('classes has an index on students for membership lookups', () => {
    expect(hasIndexOn(Class.schema, { students: 1 })).toBe(true)
  })

  it('keeps the existing unique email index on users', () => {
    expect(hasIndexOn(User.schema, { email: 1 })).toBe(true)
  })
})

import mongoose from 'mongoose'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import TeacherQuotaLock from '../src/models/TeacherQuotaLock.js'
import { withTeacherQuotaLock } from '../src/services/teacherQuotaLock.service.js'

let mongo

beforeAll(async () => {
  mongo = await MongoMemoryServer.create()
  await mongoose.connect(mongo.getUri())
  await TeacherQuotaLock.createIndexes()
})

afterAll(async () => {
  await mongoose.disconnect()
  await mongo?.stop()
})

beforeEach(async () => {
  await TeacherQuotaLock.deleteMany({})
})

describe('Teacher quota lease on standalone MongoDB', () => {
  it('serializes concurrent operations for one teacher', async () => {
    const teacherId = new mongoose.Types.ObjectId().toString()
    let active = 0
    let maximumActive = 0

    const operation = () => withTeacherQuotaLock([teacherId], async () => {
      active += 1
      maximumActive = Math.max(maximumActive, active)
      await new Promise(resolve => setTimeout(resolve, 60))
      active -= 1
    })

    await Promise.all([operation(), operation()])
    expect(maximumActive).toBe(1)
  })

  it('releases the lease when the protected operation fails', async () => {
    const teacherId = new mongoose.Types.ObjectId().toString()
    await expect(withTeacherQuotaLock([teacherId], async () => {
      throw new Error('simulated mutation failure')
    })).rejects.toThrow('simulated mutation failure')

    let ran = false
    await withTeacherQuotaLock([teacherId], async () => {
      ran = true
    })
    expect(ran).toBe(true)
  })

  it('rejects promptly when heartbeat detects a lost lease', async () => {
    const teacherId = new mongoose.Types.ObjectId().toString()
    const original = TeacherQuotaLock.findOneAndUpdate.bind(TeacherQuotaLock)
    let renewals = 0
    const spy = vi.spyOn(TeacherQuotaLock, 'findOneAndUpdate').mockImplementation(async (filter, update, options) => {
      if (filter.owner && update.$set?.leaseUntil) {
        renewals += 1
        return null
      }
      return original(filter, update, options)
    })
    let finishOperation
    const operation = new Promise(resolve => { finishOperation = resolve })
    const lock = withTeacherQuotaLock([teacherId], () => operation)
    const rejected = expect(lock).rejects.toThrow('Teacher quota lock lease was lost')

    try {
      await new Promise(resolve => setTimeout(resolve, 8_100))
      expect(renewals).toBeGreaterThan(0)
      await rejected
    } finally {
      finishOperation?.('operation settled after lost lease')
      spy.mockRestore()
    }
  }, 15_000)
})

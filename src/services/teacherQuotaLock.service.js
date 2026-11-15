import { randomUUID } from 'node:crypto'
import TeacherQuotaLock from '../models/TeacherQuotaLock.js'
import ErrorResponse from '../utils/ErrorResponse.js'

const LEASE_MS = 30_000
const RENEW_MS = 8_000
const WAIT_MS = 65_000

// Single-document leases work on standalone MongoDB; quota counts stay derived from Class records.
const isDuplicateKey = error => error?.code === 11000 || error?.code === 11001
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
const normalizeTeacherId = id => {
  const value = id?._id ?? id
  return value == null || value === 'undefined' || value === 'null' ? '' : String(value)
}

async function releaseLock(teacherId, owner) {
  try {
    await TeacherQuotaLock.findOneAndUpdate(
      { _id: teacherId, owner },
      { $set: { owner: null, leaseUntil: new Date(0) } },
      { returnDocument: 'after' },
    )
  } catch {
    // The lease expires automatically if MongoDB is temporarily unavailable.
  }
}

async function acquireLock(teacherId, owner) {
  const deadline = Date.now() + WAIT_MS
  let triedCreate = false

  while (Date.now() < deadline) {
    const now = new Date()
    const acquired = await TeacherQuotaLock.findOneAndUpdate(
      {
        _id: teacherId,
        $or: [
          { leaseUntil: { $lte: now } },
          { leaseUntil: { $exists: false } },
        ],
      },
      { $set: { owner, leaseUntil: new Date(now.getTime() + LEASE_MS) } },
      { returnDocument: 'after' },
    )
    if (acquired) return

    if (!triedCreate) {
      triedCreate = true
      try {
        await TeacherQuotaLock.create({
          _id: teacherId,
          owner,
          leaseUntil: new Date(Date.now() + LEASE_MS),
        })
        return
      } catch (error) {
        if (!isDuplicateKey(error)) throw error
      }
    }

    await wait(20 + Math.floor(Math.random() * 20))
  }

  throw new ErrorResponse('Teacher quota is busy; please retry the request.', 503, 'TEACHER_QUOTA_LOCK_TIMEOUT')
}

async function renewLock(teacherId, owner) {
  try {
    const renewed = await TeacherQuotaLock.findOneAndUpdate(
      { _id: teacherId, owner },
      { $set: { leaseUntil: new Date(Date.now() + LEASE_MS) } },
      { returnDocument: 'after' },
    )
    return renewed ? null : new Error('Teacher quota lock lease was lost')
  } catch (error) {
    return error
  }
}

export async function withTeacherQuotaLock(teacherIds, operation) {
  const ids = [...new Set((Array.isArray(teacherIds) ? teacherIds : [teacherIds]).map(normalizeTeacherId).filter(Boolean))].sort()
  if (ids.length === 0) return operation()

  const owner = randomUUID()
  const acquired = []
  try {
    for (const teacherId of ids) {
      await acquireLock(teacherId, owner)
      acquired.push(teacherId)
    }
  } catch (error) {
    for (const teacherId of acquired.reverse()) await releaseLock(teacherId, owner)
    throw error
  }

  let renewal = Promise.resolve()
  let renewalError = null
  let signalLeaseLoss
  const leaseLoss = new Promise(resolve => {
    signalLeaseLoss = resolve
  })
  const renewals = acquired.map(teacherId => async () => {
    const error = await renewLock(teacherId, owner)
    if (error) {
      renewalError = error
      signalLeaseLoss({ kind: 'lost', error })
    }
  })
  const heartbeat = setInterval(() => {
    renewal = renewal.then(async () => {
      for (const renew of renewals) await renew()
    })
  }, RENEW_MS)
  heartbeat.unref?.()

  // An in-flight database write cannot be cancelled or fenced on standalone MongoDB.
  const operationResult = Promise.resolve()
    .then(operation)
    .then(value => ({ kind: 'done', value }), error => ({ kind: 'error', error }))

  try {
    const outcome = await Promise.race([operationResult, leaseLoss])
    if (outcome.kind === 'lost') throw outcome.error
    if (renewalError) throw renewalError
    if (outcome.kind === 'error') throw outcome.error
    return outcome.value
  } finally {
    clearInterval(heartbeat)
    await renewal
    for (const teacherId of acquired.reverse()) await releaseLock(teacherId, owner)
  }
}

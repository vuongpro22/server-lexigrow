import { randomUUID } from 'node:crypto'
import AdminMutationLock from '../models/AdminMutationLock.js'
import ErrorResponse from '../utils/ErrorResponse.js'

const LOCK_ID = 'admin-user-mutations'
const STALE_WARN_MS = 5 * 60 * 1000

export async function withAdminMutationLock(operation) {
  const owner = randomUUID()
  const _id = LOCK_ID
  try {
    // Unique _id is the atomic cross-process lock, including on standalone DBs.
    await AdminMutationLock.create({ _id, owner })
  } catch (error) {
    if (error.code === 11000) {
      try {
        const existing = await AdminMutationLock.findById(_id).lean()
        const acquiredMs = existing?.acquiredAt ? new Date(existing.acquiredAt).getTime() : NaN
        const ageMs = Number.isFinite(acquiredMs) ? Date.now() - acquiredMs : null
        const staleTag = ageMs !== null && ageMs > STALE_WARN_MS ? ' [STALE]' : ''
        console.warn(
          `[AdminMutationLock]${staleTag} Contention on '${_id}' (held by ${existing?.owner || 'unknown'} since ${existing?.acquiredAt?.toISOString?.() || existing?.acquiredAt || 'unknown'})`
        )
      } catch {
        console.warn(`[AdminMutationLock] Contention on '${_id}'`)
      }
      throw new ErrorResponse('Đang có thay đổi quyền hoặc trạng thái tài khoản. Vui lòng thử lại.', 409)
    }
    throw error
  }
  try {
    return await operation()
  } finally {
    await AdminMutationLock.deleteOne({ _id, owner })
  }
}

// Only a lease older than STALE_WARN_MS may be force-released. A younger lock
// may still belong to a running mutation, and deleting it would let a second
// owner write User membership concurrently — exactly what the lock prevents.
export async function forceReleaseAdminMutationLock({ lockId = LOCK_ID, minAgeMs = STALE_WARN_MS } = {}) {
  const cutoff = new Date(Date.now() - minAgeMs)
  // Atomic: the age condition is part of the delete filter, so a lock that is
  // re-acquired between a read and the delete is never removed. A missing
  // acquiredAt (legacy row) counts as stale.
  const removed = await AdminMutationLock.findOneAndDelete({
    _id: lockId,
    acquiredAt: { $not: { $gt: cutoff } },
  }).lean()

  if (removed) {
    return { released: true, previousOwner: removed.owner || null, acquiredAt: removed.acquiredAt || null }
  }

  const existing = await AdminMutationLock.findById(lockId).lean()
  if (existing) {
    throw new ErrorResponse(
      `Khoá đang được giữ chưa tới ${Math.round(minAgeMs / 60000)} phút, có thể thao tác vẫn đang chạy. Không thể giải phóng.`,
      409,
      'LOCK_NOT_STALE',
    )
  }
  return { released: false, previousOwner: null, acquiredAt: null }
}

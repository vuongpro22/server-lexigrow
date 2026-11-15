import Class from '../models/Class.js'
import Subscription from '../models/Subscription.js'
import ErrorResponse from '../utils/ErrorResponse.js'
import { findBestActiveSubscription } from '../utils/subscriptionTier.js'

export async function getTeacherStudentQuota(teacherId) {
  const now = new Date()
  const subscription = await findBestActiveSubscription(Subscription, {
    user: teacherId, targetRole: 'teacher', status: 'active',
    startDate: { $lte: now }, endDate: { $gte: now },
  })
  const limit = subscription?.maxSponsoredStudents
  return {
    subscription,
    limit: Number.isInteger(limit) && limit >= 0 ? limit : 0,
  }
}

export async function assertStudentCapacity(cls, incomingIds) {
  // Inactive rosters consume no slots until the class is activated.
  if (cls.status !== 'active' || incomingIds.length === 0) return
  const { limit } = await getTeacherStudentQuota(cls.teacher)
  const current = await Class.distinct('students', { teacher: cls.teacher, status: 'active' })
  const existing = new Set(current.map(String))
  const incoming = [...new Set(incomingIds.map(String))]
  const added = incoming.filter(id => !existing.has(id)).length
  // An existing pupil may join another class even if legacy data is over quota.
  if (added > 0 && existing.size + added > limit) {
    throw new ErrorResponse(
      `Gói hiện tại cho phép tối đa ${limit} học sinh trên tất cả lớp đang hoạt động. Đã dùng ${existing.size} slot; không đủ chỗ để thêm học sinh.`,
      403,
    )
  }
}

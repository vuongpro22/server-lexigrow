import { beforeEach, describe, expect, it, vi } from 'vitest'
import Class from '../src/models/Class.js'
import User from '../src/models/User.js'
import Subscription from '../src/models/Subscription.js'
import SubscriptionPlan from '../src/models/SubscriptionPlan.js'
import { assertStudentCapacity } from '../src/services/studentQuota.service.js'
import { addStudent, handleJoinRequest } from '../src/controllers/class.controller.js'
import { getUserEffectiveTier, timezoneDayStart } from '../src/services/tier.service.js'

const { getTeacherStudentQuota, quotaCheck } = vi.hoisted(() => ({
  getTeacherStudentQuota: vi.fn(),
  quotaCheck: vi.fn(),
}))
vi.mock('../src/services/studentQuota.service.js', async (importOriginal) => ({ ...(await importOriginal()), getTeacherStudentQuota }))
vi.mock('../src/services/aiQuota.service.js', () => ({ checkDailyEssayQuota: quotaCheck }))
vi.mock('../src/models/Class.js', () => ({ default: { distinct: vi.fn(), findById: vi.fn(), find: vi.fn() } }))
vi.mock('../src/models/User.js', () => ({ default: { findOne: vi.fn(), findById: vi.fn() } }))
vi.mock('../src/models/Subscription.js', () => ({ default: { findOne: vi.fn() } }))
vi.mock('../src/models/SubscriptionPlan.js', () => ({ default: { findOne: vi.fn() } }))
vi.mock('../src/models/TeacherQuotaLock.js', () => ({ default: { findOneAndUpdate: vi.fn().mockResolvedValue({}), create: vi.fn() } }))
vi.mock('../src/utils/auditLogger.js', () => ({ logAction: vi.fn() }))
vi.mock('../src/services/notification.service.js', () => ({ createNotification: vi.fn() }))

const roster = Array.from({ length: 30 }, (_, i) => String(i).padStart(3, '0'))
const cls = () => ({ teacher: 'teacher', status: 'active', students: [], pendingStudents: ['new'], save: vi.fn() })
const res = () => ({ status: vi.fn().mockReturnThis(), json: vi.fn() })

describe('student slots across active classes', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    quotaCheck.mockResolvedValue({ canSubmit: true, usedToday: 0, limit: 3, remaining: 3, tierInfo: { dailyAiEssayLimit: 3, isUnlimitedAi: false } })
    User.findById.mockResolvedValue({ _id: 'student-1', role: 'student' })
    Subscription.findOne.mockReturnValue({ sort: vi.fn().mockResolvedValue({ maxSponsoredStudents: 30, tier: 'pro' }) })
    SubscriptionPlan.findOne.mockResolvedValue(null)
    Class.distinct.mockResolvedValue(roster)
  })
  it('blocks pupil 31', async () => {
    await expect(assertStudentCapacity(cls(), ['new'])).rejects.toMatchObject({ statusCode: 403 })
    expect(Class.distinct).toHaveBeenCalledWith('students', { teacher: 'teacher', status: 'active' })
  })
  it('allows pupil 30 and deduplicates incoming pupils', async () => {
    Class.distinct.mockResolvedValue(roster.slice(0, 29))
    await expect(assertStudentCapacity(cls(), ['new', 'new'])).resolves.toBeUndefined()
  })
  it('allows the same pupil in another class at capacity', async () => {
    await expect(assertStudentCapacity(cls(), [roster[0]])).resolves.toBeUndefined()
  })
  it('checks the full roster on activation', async () => {
    Class.distinct.mockResolvedValue(roster.slice(0, 29))
    await expect(assertStudentCapacity(cls(), ['a', 'b'])).rejects.toMatchObject({ statusCode: 403 })
  })
  it('does not consume slots for inactive classes', async () => {
    await assertStudentCapacity({ ...cls(), status: 'archived' }, ['new'])
    expect(Subscription.findOne).not.toHaveBeenCalled()
  })
  it('rejects adding students to an archived class before looking them up', async () => {
    const doc = { ...cls(), status: 'archived' }
    Class.findById.mockResolvedValue(doc)
    const next = vi.fn()
    await addStudent({ user: { _id: 'teacher' }, params: { id: 'class' }, body: { email: 'new@example.com' } }, res(), next)
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }))
    expect(User.findOne).not.toHaveBeenCalled()
    expect(doc.save).not.toHaveBeenCalled()
  })
  it('rejects approving a join request for an archived class', async () => {
    const doc = { ...cls(), status: 'archived' }
    Class.findById.mockResolvedValue(doc)
    const next = vi.fn()
    await handleJoinRequest({ user: { _id: 'teacher' }, params: { id: 'class', studentId: 'new' }, body: { action: 'approve' } }, res(), next)
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }))
    expect(doc.pendingStudents).toEqual(['new'])
    expect(doc.save).not.toHaveBeenCalled()
  })
  it('still allows rejecting a join request for an archived class', async () => {
    const doc = { ...cls(), status: 'archived' }
    Class.findById.mockResolvedValue(doc)
    const next = vi.fn()
    await handleJoinRequest({ user: { _id: 'teacher' }, params: { id: 'class', studentId: 'new' }, body: { action: 'reject' } }, res(), next)
    expect(next).not.toHaveBeenCalled()
    expect(doc.save).toHaveBeenCalled()
    expect(doc.pendingStudents).toEqual([])
  })
  it('uses the purchased quota rather than hardcoding 30', async () => {
    Subscription.findOne.mockReturnValue({ sort: vi.fn().mockResolvedValue({ maxSponsoredStudents: 100 }) })
    await expect(assertStudentCapacity(cls(), ['new'])).resolves.toBeUndefined()
  })
  it('does not grant slots without a current paid subscription', async () => {
    Subscription.findOne.mockReturnValue({ sort: vi.fn().mockResolvedValue(null) })
    Class.distinct.mockResolvedValue([])
    await expect(assertStudentCapacity(cls(), ['new'])).rejects.toMatchObject({ statusCode: 403 })
  })
  it('rejects adding by email before saving', async () => {
    const doc = cls()
    Class.findById.mockResolvedValue(doc)
    User.findOne.mockResolvedValue({ _id: 'new' })
    const next = vi.fn()
    await addStudent({ user: { _id: 'teacher' }, params: { id: 'class' }, body: { email: 'new@example.com' } }, res(), next)
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 403 }))
    expect(doc.save).not.toHaveBeenCalled()
    expect(doc.students).toEqual([])
  })
  it('preserves a pending request when approval fails', async () => {
    const doc = cls()
    Class.findById.mockResolvedValue(doc)
    const next = vi.fn()
    await handleJoinRequest({ user: { _id: 'teacher' }, params: { id: 'class', studentId: 'new' }, body: { action: 'approve' } }, res(), next)
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 403 }))
    expect(doc.pendingStudents).toEqual(['new'])
    expect(doc.save).not.toHaveBeenCalled()
  })
  it('still allows rejecting a request at capacity', async () => {
    const doc = cls()
    Class.findById.mockResolvedValue(doc)
    await handleJoinRequest({ user: { _id: 'teacher' }, params: { id: 'class', studentId: 'new' }, body: { action: 'reject' } }, res(), vi.fn())
    expect(doc.save).toHaveBeenCalled()
    expect(doc.pendingStudents).toEqual([])
    expect(Class.distinct).not.toHaveBeenCalled()
  })
  it('does not sponsor pupil 31 in a legacy over-quota roster', async () => {
    Subscription.findOne.mockReturnValue({ sort: vi.fn().mockResolvedValue(null) })
    getTeacherStudentQuota.mockResolvedValue({ subscription: { maxSponsoredStudents: 30, tier: 'pro' }, limit: 30 })
    Class.find.mockReturnValueOnce({ populate: vi.fn().mockResolvedValue([{ teacher: { _id: 'teacher' } }]) })
      .mockReturnValueOnce({ sort: vi.fn().mockResolvedValue([{ students: [...roster, 'zzz'] }]) })
    const tier = await getUserEffectiveTier({ _id: 'zzz', role: 'student' })
    expect(tier.source).toBe('free')
  })
  it('keeps enrolment order when selecting sponsored students instead of sorting ObjectIds', async () => {
    Subscription.findOne.mockReturnValue({ sort: vi.fn().mockResolvedValue(null) })
    getTeacherStudentQuota.mockResolvedValue({ subscription: { maxSponsoredStudents: 2, tier: 'pro' }, limit: 2 })
    Class.find.mockReturnValueOnce({ populate: vi.fn().mockResolvedValue([{ _id: 'class-1', name: 'Class A', teacher: { _id: 'teacher', name: 'Teacher', accountStatus: 'active' } }]) })
      .mockReturnValueOnce({ sort: vi.fn().mockResolvedValue([{ students: ['student-b', 'student-c', 'student-a'] }]) })

    // 'student-a' has the lowest ObjectId-like value but enrolled last, so the
    // first two designated pupils keep their sponsorship.
    const lastStudent = await getUserEffectiveTier({ _id: 'student-a', role: 'student' })
    expect(lastStudent.source).toBe('free')

    Class.find.mockReturnValueOnce({ populate: vi.fn().mockResolvedValue([{ _id: 'class-1', name: 'Class A', teacher: { _id: 'teacher', name: 'Teacher', accountStatus: 'active' } }]) })
      .mockReturnValueOnce({ sort: vi.fn().mockResolvedValue([{ students: ['student-b', 'student-c', 'student-a'] }]) })
    const firstStudent = await getUserEffectiveTier({ _id: 'student-b', role: 'student' })
    expect(firstStudent.source).toBe('teacher_sponsored')
  })
  it('uses purchased sponsorship cap rather than changed plan cap', async () => {
    Subscription.findOne.mockReturnValue({ sort: vi.fn().mockResolvedValue(null) })
    getTeacherStudentQuota.mockResolvedValue({ subscription: { plan: 'teacher-plan', tier: 'pro' }, limit: 30 })
    SubscriptionPlan.findOne.mockResolvedValue({ maxSponsoredStudents: 100, dailyAiEssayLimit: 9999, targetRole: 'teacher' })
    Class.find.mockReturnValueOnce({ populate: vi.fn().mockResolvedValue([{ _id: 'class-1', name: 'Class A', teacher: { _id: 'teacher', name: 'Teacher', accountStatus: 'active' } }]) })
      .mockReturnValueOnce({ sort: vi.fn().mockResolvedValue([{ students: [...roster.slice(0, 29), 'zzz'] }]) })
    const tier = await getUserEffectiveTier({ _id: 'zzz', role: 'student' })
    expect(SubscriptionPlan.findOne).toHaveBeenCalledWith({ _id: 'teacher-plan', targetRole: 'teacher' })
    expect(tier.source).toBe('teacher_sponsored')
  })
  it('prefers higher tier across personal and sponsorship sources without merging', async () => {
    Subscription.findOne.mockReturnValue({ sort: vi.fn().mockResolvedValue({ plan: 'personal', tier: 'plus', endDate: new Date() }) })
    SubscriptionPlan.findOne.mockResolvedValueOnce({ name: 'Personal Plus', dailyAiEssayLimit: 15, features: ['personal'] })
      .mockResolvedValueOnce({ name: 'Teacher Pro', dailyAiEssayLimit: 9999, maxClasses: 7, features: ['sponsored-plan'] })
    getTeacherStudentQuota.mockResolvedValue({ subscription: { plan: 'teacher-plan', tier: 'pro', endDate: new Date() }, limit: 30 })
    Class.find.mockReturnValueOnce({ populate: vi.fn().mockResolvedValue([{ _id: 'class-1', name: 'Class A', createdAt: new Date(1), teacher: { _id: 'teacher-1', name: 'Teacher', accountStatus: 'active' } }]) })
      .mockReturnValueOnce({ sort: vi.fn().mockResolvedValue([{ _id: 'class-1', createdAt: new Date(1), students: ['student-1'] }]) })
    const tier = await getUserEffectiveTier({ _id: 'student-1', role: 'student' })
    expect(tier).toMatchObject({ tier: 'pro', source: 'teacher_sponsored', dailyAiEssayLimit: 9999, maxClasses: 7, features: [] })
  })
  it('prefers sponsorship when personal and sponsorship tier, expiry, and quota tie', async () => {
    const sharedExpiry = new Date(Date.now() + 86_400_000)
    Subscription.findOne.mockReturnValue({ sort: vi.fn().mockResolvedValue({ plan: 'personal', tier: 'pro', endDate: sharedExpiry }) })
    SubscriptionPlan.findOne.mockResolvedValue({ name: 'Pro Plan', dailyAiEssayLimit: 9999, features: ['plan-feature'] })
    getTeacherStudentQuota.mockResolvedValue({ subscription: { plan: 'teacher-plan', tier: 'pro', endDate: sharedExpiry }, limit: 30 })
    Class.find.mockReturnValueOnce({ populate: vi.fn().mockResolvedValue([{ _id: 'class-1', name: 'Class A', createdAt: new Date(1), teacher: { _id: 'teacher-1', name: 'Teacher', accountStatus: 'active' } }]) })
      .mockReturnValueOnce({ sort: vi.fn().mockResolvedValue([{ _id: 'class-1', createdAt: new Date(1), students: ['student-1'] }]) })
    const tier = await getUserEffectiveTier({ _id: 'student-1', role: 'student' })
    expect(tier.source).toBe('teacher_sponsored')
    expect(tier.features).toEqual([])
  })
  it('prefers the later expiry after tier, source, and quota tie', async () => {
    Subscription.findOne.mockReturnValue({ sort: vi.fn().mockResolvedValue(null) })
    const earlyExpiry = new Date('2026-12-01T00:00:00Z')
    const lateExpiry = new Date('2027-01-01T00:00:00Z')
    getTeacherStudentQuota
      .mockResolvedValueOnce({ subscription: { tier: 'pro', endDate: earlyExpiry }, limit: 30 })
      .mockResolvedValueOnce({ subscription: { tier: 'pro', endDate: lateExpiry }, limit: 30 })
    SubscriptionPlan.findOne.mockResolvedValue({ dailyAiEssayLimit: 9999 })
    Class.find.mockReturnValueOnce({ populate: vi.fn().mockResolvedValue([
      { _id: 'class-a', name: 'A', createdAt: new Date(1), teacher: { _id: 'teacher-a', name: 'A', accountStatus: 'active' } },
      { _id: 'class-b', name: 'B', createdAt: new Date(2), teacher: { _id: 'teacher-b', name: 'B', accountStatus: 'active' } },
    ]) }).mockReturnValueOnce({ sort: vi.fn().mockResolvedValue([{ students: ['student-1'] }]) })
      .mockReturnValueOnce({ sort: vi.fn().mockResolvedValue([{ students: ['student-1'] }]) })

    const tier = await getUserEffectiveTier({ _id: 'student-1', role: 'student' })

    expect(tier.sponsoredByTeacher._id).toBe('teacher-b')
    expect(tier.expiresAt).toEqual(lateExpiry)
  })

  it('prefers later expiry before daily quota when tiers tie (PAY-07)', async () => {
    const earlyExpiry = new Date('2026-12-01T00:00:00Z')
    const lateExpiry = new Date('2027-06-01T00:00:00Z')
    Subscription.findOne.mockReturnValue({ sort: vi.fn().mockResolvedValue({ plan: 'personal', tier: 'pro', endDate: lateExpiry }) })
    SubscriptionPlan.findOne
      .mockResolvedValueOnce({ name: 'Personal Pro', dailyAiEssayLimit: 30 })
      .mockResolvedValueOnce({ name: 'Teacher Pro', dailyAiEssayLimit: 9999 })
    getTeacherStudentQuota.mockResolvedValue({ subscription: { plan: 'teacher-plan', tier: 'pro', endDate: earlyExpiry }, limit: 30 })
    Class.find.mockReturnValueOnce({ populate: vi.fn().mockResolvedValue([
      { _id: 'class-1', name: 'A', createdAt: new Date(1), teacher: { _id: 'teacher-1', name: 'T', accountStatus: 'active' } },
    ]) }).mockReturnValueOnce({ sort: vi.fn().mockResolvedValue([{ _id: 'class-1', createdAt: new Date(1), students: ['student-1'] }]) })

    const tier = await getUserEffectiveTier({ _id: 'student-1', role: 'student' })
    expect(tier.source).toBe('personal_subscription')
    expect(tier.expiresAt).toEqual(lateExpiry)
  })

  it('chooses highest quota then stable class order among equal-tier sponsorships', async () => {
    const sharedExpiry = new Date(Date.now() + 86_400_000)
    Subscription.findOne.mockReturnValue({ sort: vi.fn().mockResolvedValue(null) })
    getTeacherStudentQuota.mockResolvedValue({ subscription: { tier: 'pro', endDate: sharedExpiry }, limit: 30 })
    SubscriptionPlan.findOne.mockResolvedValueOnce({ dailyAiEssayLimit: 15 }).mockResolvedValueOnce({ dailyAiEssayLimit: 9999 }).mockResolvedValueOnce({ dailyAiEssayLimit: 9999 })
    Class.find.mockReturnValueOnce({ populate: vi.fn().mockResolvedValue([
      { _id: 'class-b', name: 'B', createdAt: new Date(2), teacher: { _id: 'teacher-b', name: 'B', accountStatus: 'active' } },
      { _id: 'class-a', name: 'A', createdAt: new Date(1), teacher: { _id: 'teacher-a', name: 'A', accountStatus: 'active' } },
    ]) }).mockReturnValueOnce({ sort: vi.fn().mockResolvedValue([{ students: ['student-1'] }]) }).mockReturnValueOnce({ sort: vi.fn().mockResolvedValue([{ students: ['student-1'] }]) })
    const tier = await getUserEffectiveTier({ _id: 'student-1', role: 'student' })
    expect(tier.dailyAiEssayLimit).toBe(9999)
    expect(tier.sponsoredByTeacher._id).toBe('teacher-a')
  })

  it('ranks multiple active subscriptions on the same user by tier before expiry', async () => {
    Subscription.find = vi.fn().mockReturnValue({
      sort: vi.fn().mockResolvedValue([
        { _id: 'sub-plus', plan: 'plan-plus', tier: 'plus', endDate: new Date('2028-01-01T00:00:00Z') },
        { _id: 'sub-pro', plan: 'plan-pro', tier: 'pro', endDate: new Date('2027-01-01T00:00:00Z') },
      ]),
    })
    Class.find.mockReturnValue({ populate: vi.fn().mockResolvedValue([]) })
    SubscriptionPlan.findOne.mockResolvedValue({ name: 'Student Pro', targetRole: 'student', dailyAiEssayLimit: 50, maxClasses: 5, features: [] })
    try {
      const tier = await getUserEffectiveTier({ _id: 'student-multi', role: 'student' })
      expect(tier.tier).toBe('pro')
      expect(SubscriptionPlan.findOne).toHaveBeenCalledWith({ _id: 'plan-pro', targetRole: 'student' })
    } finally {
      delete Subscription.find
    }
  })
  it('falls back to active personal plan when no eligible sponsorship exists', async () => {
    Subscription.findOne.mockReturnValue({ sort: vi.fn().mockResolvedValue({ plan: 'personal', tier: 'plus', endDate: new Date() }) })
    SubscriptionPlan.findOne.mockResolvedValue({ name: 'Personal Plus', dailyAiEssayLimit: 15 })
    Class.find.mockReturnValue({ populate: vi.fn().mockResolvedValue([]) })
    const tier = await getUserEffectiveTier({ _id: 'student-1', role: 'student' })
    expect(tier.source).toBe('personal_subscription')
    expect(tier.tier).toBe('plus')
  })
  it('uses Vietnam timezone start for quota day', async () => {
    expect(timezoneDayStart(new Date('2026-11-10T17:00:00.000Z'))).toEqual(new Date('2026-11-10T17:00:00.000Z'))
  })
  it('uses a role-matched, started direct subscription and reads its plan by id', async () => {
    Subscription.findOne.mockReturnValue({ sort: vi.fn().mockResolvedValue({ plan: 'student-plan', planSlug: 'student-pro', tier: 'pro', endDate: new Date() }) })
    Class.find.mockReturnValue({ populate: vi.fn().mockResolvedValue([]) })
    SubscriptionPlan.findOne.mockResolvedValue({ name: 'Student Pro', targetRole: 'student', dailyAiEssayLimit: 24, maxClasses: 99, features: [] })
    const tier = await getUserEffectiveTier({ _id: 'student', role: 'student' })
    expect(Subscription.findOne).toHaveBeenCalledWith(expect.objectContaining({ user: 'student', targetRole: 'student', startDate: { $lte: expect.any(Date) } }))
    expect(SubscriptionPlan.findOne).toHaveBeenCalledWith({ _id: 'student-plan', targetRole: 'student' })
    expect(tier.dailyAiEssayLimit).toBe(24)
  })
})

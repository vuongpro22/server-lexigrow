import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/models/Class.js', () => ({
  default: { exists: vi.fn(), find: vi.fn() },
}))
vi.mock('../src/models/Assignment.js', () => ({
  default: { distinct: vi.fn() },
}))
vi.mock('../src/models/Essay.js', () => ({
  default: { findById: vi.fn() },
}))
vi.mock('../src/models/ParentStudentLink.js', () => ({
  default: { exists: vi.fn(), find: vi.fn() },
}))

import Class from '../src/models/Class.js'
import Assignment from '../src/models/Assignment.js'
import ParentStudentLink from '../src/models/ParentStudentLink.js'
import {
  canAccessEssay,
  canAccessChatRoom,
  essayVisibilityFilter,
} from '../src/utils/essayAccess.js'

const linkQuery = (links) => ({
  select: vi.fn().mockReturnThis(),
  lean: vi.fn().mockResolvedValue(links),
})

describe('canAccessEssay', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('grants admins unconditionally', async () => {
    expect(await canAccessEssay({ _id: 'a', role: 'admin' }, { student: 's1' })).toBe(true)
  })

  it('only grants students their own essay', async () => {
    expect(await canAccessEssay({ _id: 's1', role: 'student' }, { student: 's1' })).toBe(true)
    expect(await canAccessEssay({ _id: 's2', role: 'student' }, { student: 's1' })).toBe(false)
  })

  it('grants teachers only for the essay own active or archived class', async () => {
    Class.exists.mockResolvedValueOnce(true)
    expect(await canAccessEssay(
      { _id: 't1', role: 'teacher' },
      { student: 's1', class: 'classA' },
    )).toBe(true)
    expect(Class.exists).toHaveBeenLastCalledWith({
      _id: 'classA',
      teacher: 't1',
      students: 's1',
      status: { $in: ['active', 'archived'] },
    })

    Class.exists.mockResolvedValueOnce(false)
    expect(await canAccessEssay(
      { _id: 't2', role: 'teacher' },
      { student: 's1', class: 'classNew' },
    )).toBe(false)
  })

  it('grants parents only while an active link exists', async () => {
    ParentStudentLink.exists.mockResolvedValueOnce(true)
    expect(
      await canAccessEssay({ _id: 'p1', role: 'parent', children: ['s1'] }, { student: 's1' })
    ).toBe(true)

    ParentStudentLink.exists.mockResolvedValueOnce(false)
    expect(
      await canAccessEssay({ _id: 'p1', role: 'parent', children: ['s9'] }, { student: 's1' })
    ).toBe(false)
  })

  it('denies a linked parent access to a draft essay', async () => {
    expect(
      await canAccessEssay({ _id: 'p1', role: 'parent' }, { student: 's1', status: 'draft' })
    ).toBe(false)
    expect(ParentStudentLink.exists).not.toHaveBeenCalled()
  })

  it('ignores a stale User.children entry after the link is revoked', async () => {
    ParentStudentLink.exists.mockResolvedValueOnce(false)
    expect(
      await canAccessEssay({ _id: 'p1', role: 'parent', children: ['s1'] }, { student: 's1' })
    ).toBe(false)
  })
})

describe('essayVisibilityFilter', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('filters a parent essay list by active links instead of stale children', async () => {
    ParentStudentLink.find.mockReturnValueOnce(linkQuery([{ student: 's1' }]))

    await expect(
      essayVisibilityFilter({ _id: 'p1', role: 'parent', children: ['stale-child'] })
    ).resolves.toEqual({
      student: { $in: ['s1'] },
      status: { $in: ['submitted', 'reviewed', 'needs_revision'] },
    })
  })

  it('includes archived classes in a teacher essay list', async () => {
    Class.find.mockReturnValueOnce({
      select: vi.fn().mockReturnThis(),
      lean: vi.fn().mockResolvedValue([
        { _id: 'classA' },
        { _id: 'classB' },
      ]),
    })
    Assignment.distinct.mockResolvedValueOnce(['assignmentA'])

    await expect(
      essayVisibilityFilter({ _id: 't1', role: 'teacher' })
    ).resolves.toEqual({
      $or: [
        { class: { $in: ['classA', 'classB'] } },
        { assignment: { $in: ['assignmentA'] } },
      ],
    })
    expect(Class.find).toHaveBeenCalledWith({
      teacher: 't1',
      status: { $in: ['active', 'archived'] },
    })
  })
})

describe('canAccessChatRoom', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('reserves the legacy shared support room for admins', async () => {
    expect(await canAccessChatRoom({ _id: 'u1', role: 'student' }, 'support')).toBe(false)
    expect(await canAccessChatRoom({ _id: 'a1', role: 'admin' }, 'support')).toBe(true)
  })

  it('allows a user into their own user room only', async () => {
    expect(await canAccessChatRoom({ _id: 'u1', role: 'student' }, 'user:u1')).toBe(true)
    expect(await canAccessChatRoom({ _id: 'u1', role: 'student' }, 'user:u2')).toBe(false)
  })

  it('lets a parent into a class room only while an active link belongs to it', async () => {
    ParentStudentLink.find.mockReturnValueOnce(linkQuery([{ student: 's1' }]))
    Class.exists.mockResolvedValueOnce(true)
    expect(
      await canAccessChatRoom({ _id: 'p1', role: 'parent', children: ['s1'] }, 'class:c1')
    ).toBe(true)

    ParentStudentLink.find.mockReturnValueOnce(linkQuery([]))
    expect(
      await canAccessChatRoom({ _id: 'p1', role: 'parent', children: [] }, 'class:c1')
    ).toBe(false)
  })
})

import Class from '../models/Class.js'
import Essay from '../models/Essay.js'
import Assignment from '../models/Assignment.js'
import ParentStudentLink from '../models/ParentStudentLink.js'

const TEACHER_VISIBLE_CLASS_STATUSES = ['active', 'archived']

const idOf = (value) => {
  if (!value) return null
  const raw = value._id ? value._id : value
  return typeof raw === 'string' ? raw : raw.toString()
}

/**
 * Resolve the class an essay actually belongs to. Older essays may only carry
 * an assignment reference, so fall back to Assignment.classId.
 */
export const resolveEssayClassId = async (essay) => {
  if (!essay) return null
  const directClassId = idOf(essay.class)
  if (directClassId) return directClassId
  const assignmentId = idOf(essay.assignment)
  if (!assignmentId) return null
  const assignment = await Assignment.findById(assignmentId).select('classId').lean()
  return idOf(assignment?.classId)
}

export const getTeacherClassIdsForStudent = async (teacherId, studentId) => {
  const classes = await Class.find({
    teacher: teacherId,
    students: studentId,
    status: { $in: TEACHER_VISIBLE_CLASS_STATUSES },
  })
    .select('_id')
    .lean()
  return classes.map((cls) => cls._id)
}

/**
 * Build the essay list filter for one student. Only essays that belong to a
 * class (or assignment of a class) taught by this teacher are included.
 * Returns null when the teacher has no common class with the student.
 */
export const buildTeacherEssayScope = async (teacherId, studentId) => {
  const classIds = await getTeacherClassIdsForStudent(teacherId, studentId)
  if (classIds.length === 0) return null
  return buildTeacherEssayScopeFromClassIds(studentId, classIds)
}

export const buildTeacherEssayScopeFromClassIds = async (studentId, classIds) => {
  if (!classIds || classIds.length === 0) return null
  const assignmentIds = await Assignment.distinct('_id', {
    classId: { $in: classIds },
  })

  return {
    student: studentId,
    status: { $ne: 'draft' },
    $or: [
      { class: { $in: classIds } },
      { assignment: { $in: assignmentIds } },
    ],
  }
}

const activeLinkedStudentIds = async (parentId) => {
  if (!parentId) return []
  const links = await ParentStudentLink.find({ parent: parentId, status: 'active' })
    .select('student')
    .lean()
  return links.map((link) => link.student)
}

/**
 * LG-05 / LG-06 / LG-07 / LG-08 / LG-09
 * Centralised object-level authorization (BOLA/IDOR) for essay access.
 *
 * Rules:
 *  - admin   : always true
 *  - student : only their own essay
 *  - teacher : only if the essay's own class (or its assignment's class) is one
 *              of the teacher's active/archived classes containing the student
 *  - parent  : only if an active ParentStudentLink exists for the essay's student
 *  - others  : false
 *
 * Parent access intentionally reads ParentStudentLink instead of the
 * denormalised User.children array: the link row is the source of truth and
 * cannot keep granting access if a previous unlink only partially succeeded.
 *
 * @param {{_id: any, role: string, children?: any[]}} user
 * @param {{student: any}} essay
 * @returns {Promise<boolean>}
 */
export const canAccessEssay = async (user, essay) => {
  if (!user || !essay || essay.deletedAt) return false
  const studentId = idOf(essay.student)
  if (!studentId) return false

  switch (user.role) {
    case 'admin':
      return true
    case 'student':
      return studentId === idOf(user._id)
    case 'teacher': {
      // Only the class the essay belongs to grants access. Having any other
      // archived class with the same student is not enough.
      const essayClassId = await resolveEssayClassId(essay)
      if (!essayClassId) return false
      return Boolean(
        await Class.exists({
          _id: essayClassId,
          teacher: user._id,
          students: studentId,
          status: { $in: TEACHER_VISIBLE_CLASS_STATUSES },
        })
      )
    }
    case 'parent':
      if (!user._id) return false
      // PARENT-05: parents only see submitted work, never an unpublished draft.
      if (essay.status === 'draft') return false
      return Boolean(
        await ParentStudentLink.exists({
          parent: user._id,
          student: studentId,
          status: 'active',
        })
      )
    default:
      return false
  }
}

/**
 * LG-15: build a Mongo filter that limits an essay *list* query to what `user`
 * is allowed to read. Returns null when the user has no essay visibility at all.
 *
 * @param {{_id: any, role: string, children?: any[]}} user
 * @returns {Promise<object|null>}
 */
export const essayVisibilityFilter = async (user) => {
  if (!user) return null

  switch (user.role) {
    case 'admin':
      return {}
    case 'student':
      return { student: user._id }
    case 'teacher': {
      const classes = await Class.find({
        teacher: user._id,
        status: { $in: TEACHER_VISIBLE_CLASS_STATUSES },
      })
        .select('_id')
        .lean()
      const classIds = classes.map((cls) => cls._id)
      if (classIds.length === 0) return null
      const assignmentIds = await Assignment.distinct('_id', {
        classId: { $in: classIds },
      })
      return {
        $or: [
          { class: { $in: classIds } },
          { assignment: { $in: assignmentIds } },
        ],
      }
    }
    case 'parent':
      return {
        student: { $in: await activeLinkedStudentIds(user._id) },
        status: { $in: ['submitted', 'reviewed', 'needs_revision'] },
      }
    default:
      return null
  }
}

/**
 * LG-10 / LG-11: decide whether a user may join / read a chat room.
 * Supported room shapes:
 *  - 'support'            : admins only (legacy shared history)
 *  - 'user:<id>'          : the owner (admins also pass)
 *  - 'class:<classId>'    : the class teacher, a student of the class, or a parent of one
 *  - 'essay:<essayId>'    : same rules as essay access
 * Unknown room shapes are denied for non-admins.
 *
 * @param {{_id: any, role: string, children?: any[]}} user
 * @param {string} room
 * @returns {Promise<boolean>}
 */
export const canAccessChatRoom = async (user, room) => {
  if (!user || typeof room !== 'string' || !room) return false
  if (user.role === 'admin') return true
  if (room === 'support') return false

  const separatorIndex = room.indexOf(':')
  if (separatorIndex === -1) return false

  const prefix = room.slice(0, separatorIndex)
  const rawId = room.slice(separatorIndex + 1)

  if (prefix === 'user') {
    return rawId === idOf(user._id)
  }

  if (prefix === 'class') {
    if (user.role === 'teacher') {
      return Boolean(await Class.exists({ _id: rawId, teacher: user._id }))
    }
    if (user.role === 'student') {
      return Boolean(await Class.exists({ _id: rawId, students: user._id }))
    }
    if (user.role === 'parent') {
      const children = await activeLinkedStudentIds(user._id)
      if (children.length === 0) return false
      return Boolean(await Class.exists({ _id: rawId, students: { $in: children } }))
    }
    return false
  }

  if (prefix === 'essay') {
    const essay = await Essay.findById(rawId).select('student status class assignment')
    return canAccessEssay(user, essay)
  }

  return false
}

// Older clients still request "support". Resolve it before authorization,
// querying, writing, or joining a socket room; never expose legacy shared data.
export const resolveChatRoom = (user, room = 'support') =>
  user?._id && user.role !== 'admin' && room === 'support' ? `user:${user._id}` : room

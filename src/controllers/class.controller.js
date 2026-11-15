import Class from '../models/Class.js'
import User from '../models/User.js'
import Essay from '../models/Essay.js'
import AIAnalysis from '../models/AIAnalysis.js'
import ErrorResponse from '../utils/ErrorResponse.js'
import asyncHandler from '../utils/asyncHandler.js'
import { classifyStudents } from '../services/studentStatus.service.js'
import { createNotification } from '../services/notification.service.js'
import { logAction } from '../utils/auditLogger.js'
import Assignment from '../models/Assignment.js'
import Alert from '../models/Alert.js'
import { escapeRegex } from '../utils/escapeRegex.js'
import mongoose from 'mongoose'
import { assertClassCapacity } from '../services/classQuota.service.js'
import { assertStudentCapacity } from '../services/studentQuota.service.js'
import { withTeacherQuotaLock } from '../services/teacherQuotaLock.service.js'

const ensureClassCanBeDeleted = async (classId) => {
  const [assignments, essays, alerts] = await Promise.all([
    Assignment.countDocuments({ classId }),
    Essay.countDocuments({ class: classId }),
    Alert.countDocuments({ class: classId }),
  ])
  if (assignments || essays || alerts) {
    throw new ErrorResponse('Class has assignments, essays or alerts. Archive it to preserve its history.', 409, 'CLASS_HAS_HISTORY')
  }
}

/**
 * Defensive cascade for a class that passed the delete guard. In normal use
 * there is no history left, but a concurrent write must not leave documents
 * pointing at a class that no longer exists.
 */
const detachClassReferences = async (classId) => {
  await Promise.all([
    Essay.updateMany({ class: classId }, { $set: { class: null } }),
    Assignment.updateMany({ classId }, { $set: { classId: null } }),
    Alert.updateMany({ class: classId }, { $set: { class: null } }),
  ])
}

const generateClassCode = () => {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  let code = ''
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length))
  }
  return code
}

const getUniqueClassCode = async () => {
  let isUnique = false
  let code = ''
  while (!isUnique) {
    code = generateClassCode()
    const existing = await Class.findOne({ code })
    if (!existing) {
      isUnique = true
    }
  }
  return code
}

/**
 * @desc    Create a new class
 * @route   POST /api/classes
 * @access  Private (teacher)
 */
export const createClass = asyncHandler(async (req, res) => {
  const { name, description, schedule } = req.body

  let cls
  await withTeacherQuotaLock([req.user._id], async () => {
    await assertClassCapacity(req.user._id)
    const code = await getUniqueClassCode()
    cls = await Class.create({
      name,
      description,
      schedule,
      teacher: req.user._id,
      code,
    })
  })

  await logAction(req.user._id, 'CREATE_CLASS', 'Class', cls._id, { name })

  res.status(201).json({ success: true, data: cls })
})

/**
 * @desc    Get all classes for teacher
 * @route   GET /api/classes
 * @access  Private (teacher)
 */
export const getClasses = asyncHandler(async (req, res) => {
  const query = req.user.role === 'teacher'
    ? { teacher: req.user._id }
    : { students: req.user._id }

  if (req.query.status) {
    query.status = req.query.status
  }

  const classes = await Class.find(query)
    .populate('students', 'name email englishLevel')
    .populate('teacher', 'name email')
    .sort({ createdAt: -1 })

  // Enrich with metrics
  const enriched = await Promise.all(classes.map(async (cls) => {
    const classObj = cls.toObject()
    const studentIds = cls.students.map(s => s._id)

    // Calculate avg TTR
    if (studentIds.length > 0) {
      const essays = await Essay.find({ student: { $in: studentIds }, status: { $ne: 'draft' } }).distinct('_id')
      const analyses = await AIAnalysis.find({ essay: { $in: essays } })
      const avgTTR = analyses.length > 0
        ? Math.round((analyses.reduce((sum, a) => sum + (a.scores?.vocabularyDiversity || 0), 0) / analyses.length) * 100) / 100
        : 0
      classObj.avgTTR = avgTTR
    } else {
      classObj.avgTTR = 0
    }

    classObj.studentCount = studentIds.length
    return classObj
  }))

  res.status(200).json({ success: true, count: enriched.length, data: enriched })
})

/**
 * @desc    Get single class detail with roster
 * @route   GET /api/classes/:id
 * @access  Private (teacher)
 */
export const getClassDetail = asyncHandler(async (req, res) => {
  let cls = await Class.findById(req.params.id)
    .populate('students', 'name email englishLevel')
    .populate('pendingStudents', 'name email englishLevel')

  if (!cls) {
    throw new ErrorResponse('Class not found', 404)
  }

  if (cls.teacher.toString() !== req.user._id.toString()) {
    throw new ErrorResponse('Not authorized', 403)
  }

  // Generate class code dynamically for legacy classes
  if (!cls.code) {
    cls.code = await getUniqueClassCode()
    await cls.save()
    // Re-query to get populated document
    cls = await Class.findById(req.params.id)
      .populate('students', 'name email englishLevel')
      .populate('pendingStudents', 'name email englishLevel')
  }

  // Get per-student metrics — classify using canonical studentStatus service
  // so that status is consistent with Dashboard and Student Analytics views.
  const studentIds = cls.students.map(s => s._id)
  const statusMap  = studentIds.length > 0 ? await classifyStudents(studentIds) : new Map()

  const roster = await Promise.all(cls.students.map(async (student) => {
    const essays    = await Essay.find({ student: student._id, status: { $ne: 'draft' } })
    const essayIds  = essays.map(e => e._id)
    const analyses  = await AIAnalysis.find({ essay: { $in: essayIds } })

    const avgTTR = analyses.length > 0
      ? Math.round((analyses.reduce((sum, a) => sum + (a.scores?.vocabularyDiversity || 0), 0) / analyses.length) * 100) / 100
      : 0

    // Growth % string (still useful for display even though status comes from service)
    let growth = '0%'
    if (analyses.length >= 2) {
      const sorted = [...analyses].sort((a, b) => b.createdAt - a.createdAt)
      const diff   = (sorted[0].scores?.vocabularyDiversity || 0) - (sorted[1].scores?.vocabularyDiversity || 0)
      const pct    = Math.round(diff * 100)
      growth = `${pct >= 0 ? '+' : ''}${pct}%`
    } else if (analyses.length === 1) {
      growth = '+0%'
    }

    // Status from canonical service
    const classification = statusMap.get(student._id.toString())
    const status = classification?.status ?? 'stagnating'

    return {
      _id:    student._id,
      name:   student.name,
      email:  student.email,
      level:  student.englishLevel || 'N/A',
      essays: essays.length,
      ttr:    avgTTR,
      growth,
      status,
    }
  }))

  // Class-level metrics
  const allEssays = await Essay.find({ student: { $in: cls.students.map(s => s._id) }, status: { $ne: 'draft' } })
  const avgWordsPerEssay = allEssays.length > 0
    ? Math.round(allEssays.reduce((sum, e) => sum + e.wordCount, 0) / allEssays.length)
    : 0

  res.status(200).json({
    success: true,
    data: {
      ...cls.toObject(),
      roster,
      metrics: {
        avgWordsPerEssay,
        totalEssays: allEssays.length,
        studentCount: cls.students.length,
      },
    },
  })
})

/**
 * @desc    Update class
 * @route   PUT /api/classes/:id
 * @access  Private (teacher, owner)
 */
export const updateClass = asyncHandler(async (req, res) => {
  let cls = await Class.findById(req.params.id)
  if (!cls) throw new ErrorResponse('Class not found', 404)
  if (cls.teacher.toString() !== req.user._id.toString()) throw new ErrorResponse('Not authorized', 403)

  const { name, description, schedule, status } = req.body
  await withTeacherQuotaLock([cls.teacher], async () => {
    cls = await Class.findById(req.params.id)
    if (!cls) throw new ErrorResponse('Class not found', 404)
    if (cls.teacher.toString() !== req.user._id.toString()) throw new ErrorResponse('Not authorized', 403)

    if (status === 'active' && cls.status !== 'active') {
      await assertClassCapacity(cls.teacher, { excludeClassId: cls._id })
      await assertStudentCapacity({ teacher: cls.teacher, status: 'active' }, cls.students)
    }
    if (name) cls.name = name
    if (description !== undefined) cls.description = description
    if (schedule !== undefined) cls.schedule = schedule
    if (status) cls.status = status
    await cls.save()
  })

  await logAction(req.user._id, 'UPDATE_CLASS', 'Class', cls._id, { name: cls.name, status: cls.status })
  res.status(200).json({ success: true, data: cls })
})

/**
 * @desc    Delete class
 * @route   DELETE /api/classes/:id
 * @access  Private (teacher, owner)
 */
export const deleteClass = asyncHandler(async (req, res) => {
  let cls = await Class.findById(req.params.id)
  if (!cls) throw new ErrorResponse('Class not found', 404)
  if (cls.teacher.toString() !== req.user._id.toString()) throw new ErrorResponse('Not authorized', 403)

  await withTeacherQuotaLock([cls.teacher], async () => {
    cls = await Class.findById(req.params.id)
    if (!cls) throw new ErrorResponse('Class not found', 404)
    if (cls.teacher.toString() !== req.user._id.toString()) throw new ErrorResponse('Not authorized', 403)
    await ensureClassCanBeDeleted(cls._id)
    await cls.deleteOne()
    await detachClassReferences(cls._id)
  })

  await logAction(req.user._id, 'DELETE_CLASS', 'Class', req.params.id, { name: cls.name })
  
  res.status(200).json({ success: true, message: 'Class deleted' })
})

/**
 * @desc    Add student to class by email
 * @route   POST /api/classes/:id/students
 * @access  Private (teacher)
 */
export const addStudent = asyncHandler(async (req, res) => {
  let cls = await Class.findById(req.params.id)
  if (!cls) throw new ErrorResponse('Class not found', 404)
  if (cls.teacher.toString() !== req.user._id.toString()) throw new ErrorResponse('Not authorized', 403)
  if (cls.status === 'archived') throw new ErrorResponse('Cannot add students to an archived class', 400)

  const student = await User.findOne({ email: req.body.email, role: 'student', accountStatus: 'active' })
  if (!student) throw new ErrorResponse('Student not found with that email', 404)

  if (cls.students.some(id => id.toString() === student._id.toString())) {
    throw new ErrorResponse('Student already in this class', 400)
  }

  await withTeacherQuotaLock([cls.teacher], async () => {
    const current = await Class.findById(req.params.id)
    if (!current) throw new ErrorResponse('Class not found', 404)
    if (current.teacher.toString() !== req.user._id.toString()) throw new ErrorResponse('Not authorized', 403)
    if (current.status === 'archived') throw new ErrorResponse('Cannot add students to an archived class', 400)
    if (current.students.some(id => id.toString() === student._id.toString())) {
      throw new ErrorResponse('Student already in this class', 400)
    }
    await assertStudentCapacity(current, [student._id])
    current.students.push(student._id)
    current.pendingStudents = current.pendingStudents.filter(id => id.toString() !== student._id.toString())
    await current.save()
    cls = current
  })

  await logAction(req.user._id, 'ADD_STUDENT', 'Class', cls._id, { studentEmail: student.email, studentName: student.name, className: cls.name })

  // Gửi thông báo realtime cho học sinh
  try {
    await createNotification({
      recipient: student._id,
      sender: req.user._id,
      title: 'Bạn đã được thêm vào lớp học mới',
      message: `Giáo viên ${req.user.name} đã thêm bạn vào lớp học "${cls.name}".`,
      type: 'system',
      link: '/',
    })
  } catch (err) {
    console.error('Failed to send class join notification:', err)
  }

  res.status(200).json({ success: true, data: cls })
})

/**
 * @desc    Remove student from class
 * @route   DELETE /api/classes/:id/students/:studentId
 * @access  Private (teacher)
 */
export const removeStudent = asyncHandler(async (req, res) => {
  let cls = await Class.findById(req.params.id)
  if (!cls) throw new ErrorResponse('Class not found', 404)
  if (cls.teacher.toString() !== req.user._id.toString()) throw new ErrorResponse('Not authorized', 403)

  await withTeacherQuotaLock([cls.teacher], async () => {
    cls = await Class.findById(req.params.id)
    if (!cls) throw new ErrorResponse('Class not found', 404)
    if (cls.teacher.toString() !== req.user._id.toString()) throw new ErrorResponse('Not authorized', 403)
    cls.students = cls.students.filter(s => s.toString() !== req.params.studentId)
    await cls.save()
  })

  await logAction(req.user._id, 'REMOVE_STUDENT', 'Class', cls._id, { studentId: req.params.studentId, className: cls.name })

  res.status(200).json({ success: true, data: cls })
})

/**
 * @desc    Get all active classes for admin
 * @route   GET /api/classes/admin
 * @access  Private (admin)
 */
export const getAdminClasses = asyncHandler(async (req, res) => {
  const { status = 'active' } = req.query
  const page = Math.max(1, parseInt(req.query.page, 10) || 1)
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 100))
  const VALID_STATUSES = ['active', 'archived', 'draft', 'all']
  if (!VALID_STATUSES.includes(status)) {
    throw new ErrorResponse(`status must be one of ${VALID_STATUSES.join(', ')}`, 400)
  }

  const filter = status === 'all' ? {} : { status }
  if (req.query.search) filter.name = { $regex: escapeRegex(String(req.query.search)), $options: 'i' }
  if (req.query.teacherId) filter.teacher = req.query.teacherId
  const classes = await Class.find(filter)
    .populate('teacher', 'name email accountStatus')
    .sort({ createdAt: -1 })
    .skip((page - 1) * limit)
    .limit(limit)

  const enriched = classes.map(cls => {
    const classObj = cls.toObject()
    classObj.studentCount = cls.students ? cls.students.length : 0
    classObj.teacherMissing = !cls.teacher || cls.teacher.accountStatus === 'deleted'
    return classObj
  })

  const total = await Class.countDocuments(filter)
  res.status(200).json({ success: true, count: enriched.length, total, page, pages: Math.ceil(total / limit) || 1, data: enriched })
})

export const getAdminClassOptions = asyncHandler(async (req, res) => {
  const filter = { status: 'active' }
  if (req.query.search) filter.name = { $regex: escapeRegex(String(req.query.search)), $options: 'i' }
  const classes = await Class.find(filter).select('name').sort({ name: 1 }).limit(30).lean()
  res.status(200).json({ success: true, data: classes })
})

export const getAdminStudentClasses = asyncHandler(async (req, res) => {
  const classes = await Class.find({ students: req.params.studentId, status: 'active' }).select('name').lean()
  res.status(200).json({ success: true, data: classes })
})

/**
 * @desc    Force enroll a student in a class
 * @route   POST /api/classes/admin/:id/enroll
 * @access  Private (admin)
 */
export const forceEnrollStudent = asyncHandler(async (req, res) => {
  let cls = await Class.findById(req.params.id)
  if (!cls) throw new ErrorResponse('Class not found', 404)
  if (cls.status === 'archived') throw new ErrorResponse('Cannot enroll students into an archived class', 400)

  const student = await User.findById(req.body.studentId)
  if (!student || student.role !== 'student' || student.accountStatus !== 'active') {
    throw new ErrorResponse('Student not found', 404)
  }
  const ownerId = String(cls.teacher)

  await withTeacherQuotaLock([ownerId], async () => {
    cls = await Class.findById(req.params.id)
    if (!cls) throw new ErrorResponse('Class not found', 404)
    if (String(cls.teacher) !== ownerId) throw new ErrorResponse('Class ownership changed; reload and retry.', 409, 'CLASS_OWNER_CHANGED')
    if (cls.status === 'archived') throw new ErrorResponse('Cannot enroll students into an archived class', 400)
    if (cls.students.some(id => id.toString() === student._id.toString())) {
      throw new ErrorResponse('Student already in this class', 400)
    }
    await assertStudentCapacity(cls, [student._id])
    cls.students.push(student._id)
    cls.pendingStudents = cls.pendingStudents.filter(id => id.toString() !== student._id.toString())
    await cls.save()
  })

  await logAction(req.user._id, 'FORCE_ENROLL_STUDENT', 'Class', cls._id, {
    studentId: student._id,
    studentEmail: student.email,
    className: cls.name,
  })

  res.status(200).json({ success: true, data: cls })
})

export const updateClassByAdmin = asyncHandler(async (req, res) => {
  let cls = await Class.findById(req.params.id)
  if (!cls) throw new ErrorResponse('Class not found', 404)
  const { name, description, schedule, teacherId } = req.body
  const requestedTeacher = teacherId !== undefined
    ? await User.findOne({ _id: teacherId, role: 'teacher', accountStatus: 'active' })
    : null
  if (teacherId !== undefined && !requestedTeacher) throw new ErrorResponse('Active teacher not found', 400)

  const previousTeacherId = String(cls.teacher)
  await withTeacherQuotaLock([cls.teacher, requestedTeacher?._id], async () => {
    cls = await Class.findById(req.params.id)
    if (!cls) throw new ErrorResponse('Class not found', 404)
    if (String(cls.teacher) !== previousTeacherId) {
      throw new ErrorResponse('Class ownership changed; reload and retry.', 409, 'CLASS_OWNER_CHANGED')
    }

    if (teacherId !== undefined) {
      const teacher = await User.findOne({ _id: teacherId, role: 'teacher', accountStatus: 'active' })
      if (!teacher) throw new ErrorResponse('Active teacher not found', 400)
      if (cls.status === 'active' && String(cls.teacher) !== String(teacher._id)) {
        await assertClassCapacity(teacher._id)
        await assertStudentCapacity({ teacher: teacher._id, status: 'active' }, cls.students)
      }
      cls.teacher = teacher._id
    }
    if (name !== undefined) cls.name = name
    if (description !== undefined) cls.description = description
    if (schedule !== undefined) cls.schedule = schedule
    await cls.save()
  })

  await logAction(req.user._id, 'ADMIN_UPDATE_CLASS', 'Class', cls._id, { name: cls.name, teacher: cls.teacher })
  res.status(200).json({ success: true, data: cls })
})

/**
 * @desc    Force unenroll a student from a class
 * @route   POST /api/classes/admin/:id/unenroll
 * @access  Private (admin)
 */
export const forceUnenrollStudent = asyncHandler(async (req, res) => {
  let cls = await Class.findById(req.params.id)
  if (!cls) throw new ErrorResponse('Class not found', 404)
  const ownerId = String(cls.teacher)

  await withTeacherQuotaLock([ownerId], async () => {
    cls = await Class.findById(req.params.id)
    if (!cls) throw new ErrorResponse('Class not found', 404)
    if (String(cls.teacher) !== ownerId) throw new ErrorResponse('Class ownership changed; reload and retry.', 409, 'CLASS_OWNER_CHANGED')
    cls.students = cls.students.filter(s => s.toString() !== req.body.studentId)
    await cls.save()
  })

  await logAction(req.user._id, 'FORCE_UNENROLL_STUDENT', 'Class', cls._id, {
    studentId: req.body.studentId,
    className: cls.name,
  })

  res.status(200).json({ success: true, data: cls })
})

/**
 * @desc    Transfer student between classes
 * @route   POST /api/classes/admin/transfer
 * @access  Private (admin)
 */
export const transferStudent = asyncHandler(async (req, res) => {
  const { studentId, fromClassId, toClassId } = req.body

  if (!studentId || !toClassId) {
    throw new ErrorResponse('Please provide studentId and toClassId', 400)
  }
  if (fromClassId && String(fromClassId) === String(toClassId)) {
    throw new ErrorResponse('Source and target class are the same', 400)
  }

  const student = await User.findById(studentId).select('name email role accountStatus')
  if (!student || student.role !== 'student' || student.accountStatus !== 'active') {
    throw new ErrorResponse('Student not found', 404)
  }

  let toClass = await Class.findById(toClassId)
  if (!toClass) throw new ErrorResponse('Target class not found', 404)
  let fromClass = fromClassId ? await Class.findById(fromClassId) : null
  if (fromClassId && !fromClass) throw new ErrorResponse('Source class not found', 404)
  const expectedTeachers = [toClass.teacher, ...(fromClass ? [fromClass.teacher] : [])]

  await withTeacherQuotaLock(expectedTeachers, async () => {
    toClass = await Class.findById(toClassId)
    if (!toClass) throw new ErrorResponse('Target class not found', 404)
    fromClass = fromClassId ? await Class.findById(fromClassId) : null
    if (fromClassId && !fromClass) throw new ErrorResponse('Source class not found', 404)
    if (String(toClass.teacher ?? '') !== String(expectedTeachers[0] ?? '') || (fromClass && String(fromClass.teacher ?? '') !== String(expectedTeachers[1] ?? ''))) {
      throw new ErrorResponse('Class ownership changed; reload and retry.', 409, 'CLASS_OWNER_CHANGED')
    }
    if (toClass.status === 'archived') throw new ErrorResponse('Cannot transfer students into an archived class', 400)
    if (fromClass && !fromClass.students.some(id => id.toString() === studentId.toString())) {
      throw new ErrorResponse('Student is not in the source class', 400)
    }

    await assertStudentCapacity(toClass, [studentId])
    const wasInTarget = toClass.students.some(id => id.toString() === studentId.toString())
    const move = async session => {
      const add = () => session
        ? Class.updateOne({ _id: toClassId }, { $addToSet: { students: studentId }, $pull: { pendingStudents: studentId } }, { session })
        : Class.updateOne({ _id: toClassId }, { $addToSet: { students: studentId }, $pull: { pendingStudents: studentId } })
      await add()
      try {
        if (fromClass) {
          const filter = { _id: fromClassId }
          const update = { $pull: { students: studentId } }
          if (session) await Class.updateOne(filter, update, { session })
          else await Class.updateOne(filter, update)
        } else {
          const filter = { students: studentId, _id: { $ne: toClassId } }
          const update = { $pull: { students: studentId } }
          if (session) await Class.updateMany(filter, update, { session })
          else await Class.updateMany(filter, update)
        }
      } catch (error) {
        if (!session && !wasInTarget) {
          try {
            await Class.updateOne({ _id: toClassId }, { $pull: { students: studentId } })
          } catch (rollbackError) {
            error.rollbackError = rollbackError
          }
        }
        throw error
      }
    }

    let movedTransactionally = false
    if (mongoose.connection.readyState === 1) {
      const session = await mongoose.startSession()
      try {
        await session.withTransaction(() => move(session))
        movedTransactionally = true
      } catch (error) {
        const unsupported = error.code === 20 || /Transaction numbers are only allowed|Transaction is not supported/.test(error.message || '')
        if (!unsupported) throw error
      } finally {
        await session.endSession()
      }
    }
    if (!movedTransactionally) await move(null)
  })

  await logAction(req.user._id, 'TRANSFER_STUDENT', 'Class', toClass._id, {
    studentId,
    studentEmail: student.email,
    fromClassId: fromClassId || null,
    toClassId,
  })
  res.status(200).json({ success: true, message: 'Student transferred successfully' })
})

/**
 * @desc    Archive a class
 * @route   PATCH /api/classes/admin/:id/archive
 * @access  Private (admin)
 */
export const archiveClassByAdmin = asyncHandler(async (req, res) => {
  let cls = await Class.findById(req.params.id)
  if (!cls) throw new ErrorResponse('Class not found', 404)
  const ownerId = String(cls.teacher)

  await withTeacherQuotaLock([ownerId], async () => {
    cls = await Class.findById(req.params.id)
    if (!cls) throw new ErrorResponse('Class not found', 404)
    if (String(cls.teacher) !== ownerId) throw new ErrorResponse('Class ownership changed; reload and retry.', 409, 'CLASS_OWNER_CHANGED')
    cls.status = 'archived'
    await cls.save()
  })
  await logAction(req.user._id, 'ADMIN_ARCHIVE_CLASS', 'Class', cls._id, { name: cls.name })

  res.status(200).json({ success: true, data: cls })
})

export const restoreClassByAdmin = asyncHandler(async (req, res) => {
  let cls = await Class.findById(req.params.id)
  if (!cls) throw new ErrorResponse('Class not found', 404)
  const ownerId = String(cls.teacher)

  await withTeacherQuotaLock([ownerId], async () => {
    cls = await Class.findById(req.params.id)
    if (!cls) throw new ErrorResponse('Class not found', 404)
    if (String(cls.teacher) !== ownerId) throw new ErrorResponse('Class ownership changed; reload and retry.', 409, 'CLASS_OWNER_CHANGED')
    const teacher = await User.findOne({ _id: cls.teacher, role: 'teacher', accountStatus: 'active' })
    if (!teacher) throw new ErrorResponse('Assign an active teacher before restoring this class', 409)
    if (cls.status !== 'active') {
      await assertClassCapacity(teacher._id, { excludeClassId: cls._id })
      await assertStudentCapacity({ teacher: teacher._id, status: 'active' }, cls.students)
    }
    cls.status = 'active'
    await cls.save()
  })
  await logAction(req.user._id, 'ADMIN_RESTORE_CLASS', 'Class', cls._id, { name: cls.name })
  res.status(200).json({ success: true, data: cls })
})

/**
 * @desc    Delete a class by admin
 * @route   DELETE /api/classes/admin/:id
 * @access  Private (admin)
 */
export const deleteClassByAdmin = asyncHandler(async (req, res) => {
  let cls = await Class.findById(req.params.id)
  if (!cls) throw new ErrorResponse('Class not found', 404)
  const ownerId = String(cls.teacher)

  await withTeacherQuotaLock([ownerId], async () => {
    cls = await Class.findById(req.params.id)
    if (!cls) throw new ErrorResponse('Class not found', 404)
    if (String(cls.teacher) !== ownerId) throw new ErrorResponse('Class ownership changed; reload and retry.', 409, 'CLASS_OWNER_CHANGED')
    await ensureClassCanBeDeleted(cls._id)
    await cls.deleteOne()
    await detachClassReferences(cls._id)
  })
  await logAction(req.user._id, 'ADMIN_DELETE_CLASS', 'Class', cls._id, { name: cls.name })
  res.status(200).json({ success: true, message: 'Class deleted successfully' })
})

/**
 * @desc    Get class detail for admin
 * @route   GET /api/classes/admin/:id
 * @access  Private (admin)
 */
export const getAdminClassDetail = asyncHandler(async (req, res) => {
  const cls = await Class.findById(req.params.id)
    .populate('teacher', 'name email')
    .populate('students', 'name email englishLevel')

  if (!cls) {
    throw new ErrorResponse('Class not found', 404)
  }

  res.status(200).json({ success: true, data: cls })
})

/**
 * @desc    Get single class detail for student (Overview & classmate list)
 * @route   GET /api/classes/:id/student-view
 * @access  Private (student)
 */
export const getStudentClassDetail = asyncHandler(async (req, res) => {
  const cls = await Class.findById(req.params.id)
    .populate('students', 'name email englishLevel')
    .populate('teacher', 'name email')

  if (!cls) {
    throw new ErrorResponse('Class not found', 404)
  }

  // Verify the student is enrolled in this class
  const isEnrolled = cls.students.some(s => s._id.toString() === req.user._id.toString())
  if (!isEnrolled) {
    throw new ErrorResponse('Not authorized to access this class', 403)
  }

  res.status(200).json({ success: true, data: cls })
})

/**
 * @desc    Get all users by role for admin dropdowns
 * @route   GET /api/classes/admin/users
 * @access  Private (admin)
 */
export const getAdminUsers = asyncHandler(async (req, res) => {
  const { role } = req.query

  if (!role || !['student', 'teacher'].includes(role)) {
    throw new ErrorResponse('Please specify a valid role (student or teacher)', 400)
  }

  const page = Math.max(1, parseInt(req.query.page, 10) || 1)
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 100))
  const filter = { role, accountStatus: 'active' }
  if (req.query.search) {
    const pattern = escapeRegex(String(req.query.search))
    filter.$or = [{ name: { $regex: pattern, $options: 'i' } }, { email: { $regex: pattern, $options: 'i' } }]
  }
  const users = await User.find(filter).select('name email englishLevel').sort({ name: 1 }).skip((page - 1) * limit).limit(limit)
  const total = await User.countDocuments(filter)
  res.status(200).json({ success: true, count: users.length, total, page, pages: Math.ceil(total / limit) || 1, data: users })
})

/**
 * @desc    Student joins class by class code
 * @route   POST /api/classes/join
 * @access  Private (student)
 */
export const joinClassByCode = asyncHandler(async (req, res) => {
  const { code } = req.body
  if (!code) {
    throw new ErrorResponse('Please provide a class code', 400)
  }

  const cls = await Class.findOne({ code: code.toUpperCase().trim() })
  if (!cls) {
    throw new ErrorResponse('Class not found with this code', 404)
  }

  // Check if student is already enrolled
  const isEnrolled = cls.students.some(s => s.toString() === req.user._id.toString())
  if (isEnrolled) {
    throw new ErrorResponse('You are already enrolled in this class', 400)
  }

  // Check if request is already pending
  const isPending = cls.pendingStudents?.some(s => s.toString() === req.user._id.toString())
  if (isPending) {
    throw new ErrorResponse('Your request to join this class is already pending approval', 400)
  }

  await Class.updateOne({ _id: cls._id }, { $addToSet: { pendingStudents: req.user._id } })

  // Create audit log and notification for teacher
  await logAction(req.user._id, 'JOIN_REQUEST_SENT', 'Class', cls._id, { className: cls.name })
  await createNotification({
    recipient: cls.teacher,
    sender: req.user._id,
    type: 'system',
    title: 'New Class Join Request',
    message: `${req.user.name} requested to join your class "${cls.name}".`,
    link: `/teacher/class/${cls._id}`
  })

  res.status(200).json({
    success: true,
    message: 'Join request sent successfully! Waiting for teacher approval.'
  })
})

/**
 * @desc    Student gets their pending class requests
 * @route   GET /api/classes/my-pending
 * @access  Private (student)
 */
export const getMyPendingClasses = asyncHandler(async (req, res) => {
  const classes = await Class.find({ pendingStudents: req.user._id })
    .populate('teacher', 'name email')
    .select('name description teacher')
  res.status(200).json({ success: true, count: classes.length, data: classes })
})

/**
 * @desc    Teacher handles (approve/reject) pending student join request
 * @route   POST /api/classes/:id/requests/:studentId/handle
 * @access  Private (teacher)
 */
export const handleJoinRequest = asyncHandler(async (req, res) => {
  const { action } = req.body
  const { id, studentId } = req.params
  if (!['approve', 'reject'].includes(action)) {
    throw new ErrorResponse('Invalid action. Choose approve or reject.', 400)
  }

  let cls = await Class.findById(id)
  if (!cls) throw new ErrorResponse('Class not found', 404)
  if (cls.teacher.toString() !== req.user._id.toString()) {
    throw new ErrorResponse('Not authorized to manage this class requests', 403)
  }
  if (action === 'approve' && cls.status === 'archived') {
    throw new ErrorResponse('Cannot approve join requests for an archived class', 400)
  }
  const ownerId = String(cls.teacher)

  await withTeacherQuotaLock([ownerId], async () => {
    cls = await Class.findById(id)
    if (!cls) throw new ErrorResponse('Class not found', 404)
    if (String(cls.teacher) !== ownerId || cls.teacher.toString() !== req.user._id.toString()) {
      throw new ErrorResponse('Not authorized to manage this class requests', 403)
    }
    if (action === 'approve' && cls.status === 'archived') {
      throw new ErrorResponse('Cannot approve join requests for an archived class', 400)
    }
    const isPending = cls.pendingStudents?.some(s => s.toString() === studentId.toString())
    if (!isPending) throw new ErrorResponse('Student join request not found in pending list', 404)

    if (action === 'approve') await assertStudentCapacity(cls, [studentId])
    cls.pendingStudents = cls.pendingStudents.filter(s => s.toString() !== studentId.toString())
    if (action === 'approve' && !cls.students.some(id => id.toString() === studentId.toString())) {
      cls.students.push(studentId)
    }
    await cls.save()
  })

  if (action === 'approve') {
    await logAction(req.user._id, 'APPROVE_JOIN_REQUEST', 'Class', cls._id, { studentId })
    await createNotification({
      recipient: studentId,
      sender: req.user._id,
      type: 'system',
      title: 'Join Request Approved',
      message: 'You have been approved to join the class "' + cls.name + '".',
      link: '/student/class/' + cls._id,
    })
  } else {
    await logAction(req.user._id, 'REJECT_JOIN_REQUEST', 'Class', cls._id, { studentId })
    await createNotification({
      recipient: studentId,
      sender: req.user._id,
      type: 'system',
      title: 'Join Request Rejected',
      message: 'Your request to join the class "' + cls.name + '" was declined.',
      link: '/student/class',
    })
  }

  res.status(200).json({
    success: true,
    message: 'Successfully ' + (action === 'approve' ? 'approved' : 'rejected') + ' student join request.',
  })
})

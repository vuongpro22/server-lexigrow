import 'dotenv/config'
import mongoose from 'mongoose'
import Class from '../src/models/Class.js'
import Assignment from '../src/models/Assignment.js'
import Alert from '../src/models/Alert.js'
import Essay from '../src/models/Essay.js'
import User from '../src/models/User.js'
import { assertLocalTestMongoUri } from './localTestDatabaseGuard.js'

const apply = process.argv.includes('--apply')
if (!['development', 'test'].includes(process.env.NODE_ENV)) {
  throw new Error('repairOrphanClasses is restricted to NODE_ENV=development or test')
}
if (apply && process.env.RUN_REPAIR_ORPHAN_CLASSES !== 'true') {
  throw new Error('Set RUN_REPAIR_ORPHAN_CLASSES=true to apply this repair')
}
assertLocalTestMongoUri(process.env.MONGO_URI, 'repairOrphanClasses', 'lexigrow_dev5_test')

await mongoose.connect(process.env.MONGO_URI, { retryWrites: false })
try {
  const [classes, assignments, alerts, essays] = await Promise.all([
    Class.find().select('_id').lean(),
    Assignment.find({ classId: { $ne: null } }).select('classId teacher').lean(),
    Alert.find({ class: { $ne: null } }).select('class teacher').lean(),
    Essay.find({ class: { $ne: null } }).select('class').lean(),
  ])
  const existing = new Set(classes.map(item => String(item._id)))
  const groups = new Map()
  const add = (id, teacher, kind) => {
    if (!id || existing.has(String(id))) return
    const key = String(id)
    if (!groups.has(key)) groups.set(key, { id: key, teacherIds: new Set(), counts: { assignments: 0, alerts: 0, essays: 0 } })
    const group = groups.get(key)
    if (teacher) group.teacherIds.add(String(teacher))
    group.counts[kind] += 1
  }
  assignments.forEach(item => add(item.classId, item.teacher, 'assignments'))
  alerts.forEach(item => add(item.class, item.teacher, 'alerts'))
  essays.forEach(item => add(item.class, null, 'essays'))

  const plan = []
  for (const group of groups.values()) {
    const teachers = [...group.teacherIds]
    const teacherExists = teachers.length === 1 && await User.exists({ _id: teachers[0] })
    plan.push({ id: group.id, teacherId: teachers.length === 1 ? teachers[0] : null, teacherExists: Boolean(teacherExists), ...group.counts })
  }
  console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', classesToRestore: plan }, null, 2))
  if (apply) {
    for (const item of plan) {
      if (!item.teacherExists) throw new Error(`Cannot restore ${item.id}: teacher is missing or ambiguous`)
    }
    for (const item of plan) {
      if (await Class.exists({ _id: item.id })) continue
      await Class.create({
        _id: item.id,
        name: `Recovered deleted class ${item.id.slice(-6)}`,
        description: 'Archived placeholder restored to preserve historical references.',
        status: 'archived',
        teacher: item.teacherId,
      })
    }
    console.log(JSON.stringify({ restored: plan.length }))
  }
} finally {
  await mongoose.disconnect()
}

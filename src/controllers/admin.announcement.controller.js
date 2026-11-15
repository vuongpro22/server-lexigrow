import Announcement from '../models/Announcement.js'
import AuditLog from '../models/AuditLog.js'
import asyncHandler from '../utils/asyncHandler.js'

const AUDIENCES = ['all', 'student', 'teacher', 'parent']
const PRIORITIES = ['normal', 'important', 'critical']
const STATUSES = ['draft', 'published', 'archived']

function parseDate(value) {
  if (!value) return null
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

function validatePayload(body, { partial = false } = {}) {
  const errors = []
  const data = {}

  if (body.title !== undefined || !partial) {
    const title = typeof body.title === 'string' ? body.title.trim() : ''
    if (!title) errors.push('title is required')
    else if (title.length > 160) errors.push('title must be 160 characters or fewer')
    else data.title = title
  }

  if (body.body !== undefined || !partial) {
    const content = typeof body.body === 'string' ? body.body.trim() : ''
    if (!content) errors.push('body is required')
    else if (content.length > 5000) errors.push('body must be 5000 characters or fewer')
    else data.body = content
  }

  if (body.audience !== undefined) {
    if (!AUDIENCES.includes(body.audience)) errors.push(`audience must be one of ${AUDIENCES.join(', ')}`)
    else data.audience = body.audience
  }

  if (body.priority !== undefined) {
    if (!PRIORITIES.includes(body.priority)) errors.push(`priority must be one of ${PRIORITIES.join(', ')}`)
    else data.priority = body.priority
  }

  if (body.status !== undefined) {
    if (!STATUSES.includes(body.status)) errors.push(`status must be one of ${STATUSES.join(', ')}`)
    else data.status = body.status
  }

  for (const field of ['publishAt', 'expiresAt']) {
    if (body[field] !== undefined) {
      if (body[field] === null || body[field] === '') data[field] = null
      else {
        const parsed = parseDate(body[field])
        if (!parsed) errors.push(`${field} must be a valid date`)
        else data[field] = parsed
      }
    }
  }

  if (data.publishAt && data.expiresAt && data.expiresAt <= data.publishAt) {
    errors.push('expiresAt must be after publishAt')
  }

  return { errors, data }
}

async function recordAudit(req, action, announcement, detail) {
  try {
    await AuditLog.create({
      user: req.user?._id,
      actorName: req.user?.name || '',
      actorEmail: req.user?.email || '',
      actorRole: req.user?.role || '',
      action,
      targetType: 'Announcement',
      targetId: String(announcement?._id || ''),
      details: { message: detail },
    })
  } catch {
    // Audit logging must never fail the request it describes.
  }
}

// Published announcements that are inside their publish/expiry window right now.
const activeWindowClauses = (now) => [
  { $or: [{ publishAt: null }, { publishAt: { $lte: now } }] },
  { $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }] },
]

export const listAnnouncements = asyncHandler(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1)
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20))
  const filter = {}

  if (req.query.status && STATUSES.includes(req.query.status)) filter.status = req.query.status
  // The Published tab must match the "published" stat: scheduled or expired
  // items keep status=published in the DB but are not live.
  const andClauses = filter.status === 'published' ? activeWindowClauses(new Date()) : []
  if (req.query.audience && AUDIENCES.includes(req.query.audience)) filter.audience = req.query.audience
  if (req.query.search) {
    const escaped = String(req.query.search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    filter.$or = [
      { title: { $regex: escaped, $options: 'i' } },
      { body: { $regex: escaped, $options: 'i' } },
    ]
  }

  if (andClauses.length) filter.$and = andClauses

  const [items, total] = await Promise.all([
    Announcement.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .populate('createdBy', 'name email')
      .lean(),
    Announcement.countDocuments(filter),
  ])

  res.json({
    success: true,
    data: items,
    pagination: { total, page, limit, pages: Math.max(1, Math.ceil(total / limit)) },
  })
})

export const getAnnouncementStats = asyncHandler(async (req, res) => {
  const now = new Date()
  const [total, published, draft, archived] = await Promise.all([
    Announcement.countDocuments(),
    Announcement.countDocuments({
      status: 'published',
      $and: activeWindowClauses(now),
    }),
    Announcement.countDocuments({ status: 'draft' }),
    Announcement.countDocuments({ status: 'archived' }),
  ])

  res.json({ success: true, data: { total, published, draft, archived } })
})

export const createAnnouncement = asyncHandler(async (req, res) => {
  const { errors, data } = validatePayload(req.body)
  if (errors.length) {
    return res.status(400).json({ success: false, message: errors.join('; ') })
  }

  const announcement = await Announcement.create({
    ...data,
    createdBy: req.user._id,
  })
  await recordAudit(req, 'announcement.create', announcement, `Created announcement "${announcement.title}"`)

  res.status(201).json({ success: true, data: announcement })
})

export const updateAnnouncement = asyncHandler(async (req, res) => {
  const announcement = await Announcement.findById(req.params.id)
  if (!announcement) {
    return res.status(404).json({ success: false, message: 'Announcement not found' })
  }

  const { errors, data } = validatePayload(req.body, { partial: true })
  if (errors.length) {
    return res.status(400).json({ success: false, message: errors.join('; ') })
  }

  const nextPublishAt = data.publishAt !== undefined ? data.publishAt : announcement.publishAt
  const nextExpiresAt = data.expiresAt !== undefined ? data.expiresAt : announcement.expiresAt
  if (nextPublishAt && nextExpiresAt && nextExpiresAt <= nextPublishAt) {
    return res.status(400).json({ success: false, message: 'expiresAt must be after publishAt' })
  }

  Object.assign(announcement, data, { updatedBy: req.user._id })
  await announcement.save()
  await recordAudit(req, 'announcement.update', announcement, `Updated announcement "${announcement.title}"`)

  res.json({ success: true, data: announcement })
})

export const deleteAnnouncement = asyncHandler(async (req, res) => {
  const announcement = await Announcement.findById(req.params.id)
  if (!announcement) {
    return res.status(404).json({ success: false, message: 'Announcement not found' })
  }

  await announcement.deleteOne()
  await recordAudit(req, 'announcement.delete', announcement, `Deleted announcement "${announcement.title}"`)

  res.json({ success: true, message: 'Announcement deleted' })
})

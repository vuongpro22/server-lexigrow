import AuditLog from '../models/AuditLog.js'
import User from '../models/User.js'
import Essay from '../models/Essay.js'
import Class from '../models/Class.js'
import AIAnalysis from '../models/AIAnalysis.js'
import Config from '../models/Config.js'
import AILog from '../models/AILog.js'
import asyncHandler from '../utils/asyncHandler.js'
import ErrorResponse from '../utils/ErrorResponse.js'
import { escapeRegex } from '../utils/escapeRegex.js'
import { encryptSecret } from '../utils/secretCrypto.js'
import { estimateCost } from '../services/aiGateway.service.js'
import { forceReleaseAdminMutationLock } from '../services/adminMutationLock.service.js'
import { logAction } from '../utils/auditLogger.js'
import { randomBytes } from 'node:crypto'
import mongoose from 'mongoose'

const REMOVED_CONFIG_KEYS = new Set(['HF_API_TOKEN'])

const parseDateFilter = (value) => {
  const parsed = new Date(value)
  if (!Number.isFinite(parsed.getTime())) throw new ErrorResponse('Invalid date filter', 400)
  return parsed
}

async function buildAuditQuery({ action, role, startDate, endDate, search }) {
  const query = {}
  const clauses = []

  // 1. Filter by role
  if (role) {
    const usersWithRole = await User.find({ role }).select('_id')
    clauses.push({ $or: [{ user: { $in: usersWithRole.map(u => u._id) } }, { actorRole: role }] })
  }

  // 2. Filter by search (user name or email)
  if (search) {
    const pattern = escapeRegex(search)
    const matchedUsers = await User.find({
      $or: [
        { name: { $regex: pattern, $options: 'i' } },
        { email: { $regex: pattern, $options: 'i' } }
      ]
    }).select('_id')

    const deletedActors = await AuditLog.find({
      action: 'ADMIN_DELETE_USER',
      $or: [
        { 'details.name': { $regex: pattern, $options: 'i' } },
        { 'details.email': { $regex: pattern, $options: 'i' } },
      ],
    }).select('targetId').lean()
    const deletedActorIds = deletedActors
      .map(log => log.targetId)
      .filter(id => mongoose.Types.ObjectId.isValid(id))

    const actorSearch = [
      { user: { $in: [...matchedUsers.map(u => u._id), ...deletedActorIds] } },
      { actorName: { $regex: pattern, $options: 'i' } },
      { actorEmail: { $regex: pattern, $options: 'i' } },
    ]
    clauses.push({ $or: actorSearch })
  }

  if (clauses.length === 1) {
    query.$or = clauses[0].$or
  } else if (clauses.length > 1) {
    query.$and = clauses
  }

  // 3. Filter by action
  if (action) {
    query.action = action
  }

  // 4. Filter by date range
  if (startDate || endDate) {
    query.createdAt = {}
    if (startDate) query.createdAt.$gte = parseDateFilter(startDate)
    if (endDate) query.createdAt.$lte = parseDateFilter(endDate)
  }

  return query
}

/**
 * @desc    Get paginated audit logs with filters
 * @route   GET /api/admin/logs
 * @access  Private (Admin)
 */
export const getAuditLogs = asyncHandler(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1)
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 10))
  const skip = (page - 1) * limit

  const query = await buildAuditQuery(req.query)

  const total = await AuditLog.countDocuments(query)
  const logs = await AuditLog.find(query)
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit)
    .populate('user', 'name email role avatar')

  res.status(200).json({
    success: true,
    pagination: {
      total,
      page,
      limit,
      pages: Math.ceil(total / limit)
    },
    data: logs
  })
})

/**
 * @desc    Get system analytics counts and chart data
 * @route   GET /api/admin/analytics
 * @access  Private (Admin)
 */
export const getSystemAnalytics = asyncHandler(async (req, res) => {
  // 1. Simple Counts
  const totalUsers = await User.countDocuments({ accountStatus: { $ne: 'deleted' } })
  const totalEssays = await Essay.countDocuments({ status: { $ne: 'draft' } })
  const totalClasses = await Class.countDocuments()

  // 2. Active role counts
  const studentsCount = await User.countDocuments({ role: 'student', accountStatus: { $ne: 'deleted' } })
  const teachersCount = await User.countDocuments({ role: 'teacher', accountStatus: { $ne: 'deleted' } })
  const parentsCount = await User.countDocuments({ role: 'parent', accountStatus: { $ne: 'deleted' } })

  // Analysis rows are retained with their soft-deleted essay for audit history,
  // but must not contribute to live dashboard scores. Lookup filters do not
  // run Essay query middleware, so apply the deletion filter explicitly.
  const liveEssayAnalyses = [
    { $lookup: { from: 'essays', localField: 'essay', foreignField: '_id',
      pipeline: [{ $match: { deletedAt: null } }, { $project: { _id: 1 } }], as: '_liveEssay' } },
    { $match: { '_liveEssay.0': { $exists: true } } },
  ]

  // 3. Overall average essay grade
  const scoreStats = await AIAnalysis.aggregate([
    ...liveEssayAnalyses,
    { $group: { _id: null, average: { $avg: { $ifNull: ['$overallScore', 0] } } } },
  ])
  const avgScore = Math.round((scoreStats[0]?.average || 0) * 10) / 10

  // 4. User Registration Growth over time (grouped by week)
  const userGrowth = await User.aggregate([
    { $match: { accountStatus: { $ne: 'deleted' } } },
    {
      $group: {
        _id: {
          year: { $year: "$createdAt" },
          week: { $week: "$createdAt" }
        },
        count: { $sum: 1 },
        date: { $min: "$createdAt" }
      }
    },
    { $sort: { "_id.year": -1, "_id.week": -1 } },
    { $limit: 10 }
  ])

  // Format week registrations. The query takes the most recent weeks, so flip
  // back to chronological order for the chart.
  const userGrowthData = userGrowth.reverse().map(item => ({
    label: `W${item._id.week}, ${item._id.year}`,
    count: item.count
  }))

  // 5. Essay submissions trend (grouped by date)
  const essaySubmissions = await Essay.aggregate([
    { $match: { status: { $ne: 'draft' } } },
    {
      $group: {
        _id: {
          $dateToString: {
            format: "%Y-%m-%d",
            date: { $ifNull: ["$submittedAt", "$createdAt"] }
          }
        },
        count: { $sum: 1 }
      }
    },
    { $sort: { _id: -1 } },
    { $limit: 15 }
  ])

  // Most recent days first from the query; reverse for a left-to-right timeline.
  const essaySubmissionData = essaySubmissions.reverse().map(item => ({
    label: item._id,
    count: item.count
  }))

  // 6. Score distribution (0-2, 2-4, 4-6, 6-8, 8-10)
  const scoreBuckets = await AIAnalysis.aggregate([
    ...liveEssayAnalyses,
    {
      $bucket: {
        groupBy: "$overallScore",
        boundaries: [0, 2, 4, 6, 8, 10.1],
        default: 11,
        output: {
          count: { $sum: 1 }
        }
      }
    }
  ])

  const scoreMap = { 0: '0-2', 2: '2-4', 4: '4-6', 6: '6-8', 8: '8-10' }
  const scoreDistributionData = Object.keys(scoreMap).map(boundary => {
    const bucket = scoreBuckets.find(b => b._id === Number(boundary))
    return {
      range: scoreMap[boundary],
      count: bucket ? bucket.count : 0
    }
  })

  res.status(200).json({
    success: true,
    data: {
      metrics: {
        totalUsers,
        totalEssays,
        totalClasses,
        avgScore,
        roles: {
          student: studentsCount,
          teacher: teachersCount,
          parent: parentsCount
        }
      },
      charts: {
        userGrowth: userGrowthData,
        essaySubmissions: essaySubmissionData,
        scoreDistribution: scoreDistributionData
      }
    }
  })
})

/**
 * @desc    Seed mock data for audit logs and system analytics charts
 * @route   POST /api/admin/logs/seed
 * @access  Private (Admin)
 */
export const seedMockData = asyncHandler(async (req, res) => {
  // Ensure we have some users, classes, essays, analysis, and logs to show
  const adminUser = req.user

  // 1. Create a mock teacher
  let teacher = await User.findOne({ role: 'teacher' })
  if (!teacher) {
    teacher = await User.create({
      name: 'Nguyễn Văn Dạy',
      email: 'teacher.mock@lexigrow.edu.vn',
      password: randomBytes(24).toString('hex'),
      role: 'teacher',
      institution: 'Hanoi University'
    })
  }

  // 2. Create a mock student
  let student = await User.findOne({ role: 'student' })
  if (!student) {
    student = await User.create({
      name: 'Trần Văn Học',
      email: 'student.mock@lexigrow.edu.vn',
      password: randomBytes(24).toString('hex'),
      role: 'student',
      englishLevel: 'B1'
    })
  }

  // 3. Create mock classes
  let cls = await Class.findOne()
  if (!cls) {
    cls = await Class.create({
      name: 'IELTS Advanced 2026',
      description: 'Lớp luyện thi IELTS cấp tốc',
      schedule: 'T2/T4/T6 19:30',
      teacher: teacher._id,
      students: [student._id]
    })
  }

  // 4. Create historical essays & AI analysis records
  const essayCount = await Essay.countDocuments()
  if (essayCount < 10) {
    const titles = [
      'The Impact of Fast Food on Health',
      'Should Education be Free for Everyone?',
      'Online Learning vs Traditional Classrooms',
      'Renewable Energy is the Future',
      'The Influence of Social Media on Teenagers',
      'Should Animals be Kept in Zoos?',
      'The Role of Technology in Modern Agriculture',
      'Public Transport and City Air Quality',
      'Benefits of Learning a Foreign Language',
      'Artificial Intelligence in Healthcare'
    ]

    const baseDate = new Date()
    for (let i = 0; i < titles.length; i++) {
      const submittedDate = new Date(baseDate)
      submittedDate.setDate(baseDate.getDate() - (10 - i))

      const essay = await Essay.create({
        title: titles[i],
        content: `Writing about ${titles[i]} has become a major subject of research and study. There are various viewpoints concerning this matter. Firstly, some people argue that the benefits are undeniable. However, others suggest that negative consequences outweigh these advantages. In this essay, I will discuss both sides and present my own perspective.`,
        status: 'reviewed',
        student: student._id,
        class: cls._id,
        wordCount: 150 + (i * 12),
        paragraphCount: 4,
        sentenceCount: 12 + i,
        readingTime: 1,
        submittedAt: submittedDate,
        createdAt: submittedDate
      })

      // Create AI Analysis
      const score = 4.5 + (i * 0.5) // scores from 4.5 to 9.0
      await AIAnalysis.create({
        essay: essay._id,
        overallScore: score,
        scores: {
          vocabularyDiversity: 0.45 + (i * 0.03),
          grammarAccuracy: Math.min(10, Math.floor(score)),
          coherence: Math.min(10, Math.floor(score - 0.5)),
          complexityIndex: Math.min(10, Math.floor(score + 0.5)),
          lexicalDiversityHdd: 0.55 + (i * 0.02),
          lexicalDiversityMtld: 45 + (i * 3)
        },
        writingStats: {
          avgSentenceLength: 15,
          uniqueWords: 80 + (i * 5)
        }
      })
    }
  }

  // 5. Create historical audit logs
  const logCount = await AuditLog.countDocuments()
  if (logCount < 15) {
    const actions = [
      { action: 'CREATE_CLASS', targetType: 'Class', details: { name: 'IELTS Advanced 2026' } },
      { action: 'ADD_STUDENT', targetType: 'Class', details: { studentEmail: 'student.mock@lexigrow.edu.vn', className: 'IELTS Advanced 2026' } },
      { action: 'CREATE_PROMPT', targetType: 'SystemPrompt', details: { name: 'IELTS Band Scoring System' } },
      { action: 'UPDATE_PROMPT', targetType: 'SystemPrompt', details: { name: 'IELTS Band Scoring System', field: 'template' } },
      { action: 'RESOLVE_ALERT', targetType: 'Alert', details: { alertType: 'Stagnating Vocabulary', studentName: 'Trần Văn Học' } },
      { action: 'ADMIN_UPDATE_USER_STATUS', targetType: 'User', details: { targetUserEmail: 'spammer@lexigrow.com', reason: 'Spam comments' } },
      { action: 'ADMIN_APPROVE_USER', targetType: 'User', details: { targetUserEmail: 'teacher.new@lexigrow.edu.vn', role: 'teacher' } }
    ]

    const baseDate = new Date()
    for (let i = 0; i < 20; i++) {
      const logDate = new Date(baseDate)
      logDate.setHours(baseDate.getHours() - (i * 4)) // logs spread over a few days

      const act = actions[i % actions.length]
      await AuditLog.create({
        user: adminUser._id,
        actorName: adminUser.name || '',
        actorEmail: adminUser.email || '',
        actorRole: adminUser.role || '',
        action: act.action,
        targetType: act.targetType,
        details: act.details,
        createdAt: logDate
      })
    }
  }

  // 6. Create historical AI logs
  const aiLogCount = await AILog.countDocuments()
  if (aiLogCount < 20) {
    const models = ['openai/gpt-oss-120b', 'qwen/qwen3.8-27b', 'openai/gpt-oss-20b']
    const actions = ['essay_analysis', 'synonym_generation', 'topic_generation', 'vocabulary_enrichment']
    const baseDate = new Date()
    
    for (let i = 0; i < 40; i++) {
      const logDate = new Date(baseDate)
      logDate.setDate(baseDate.getDate() - (i % 7)) // Spread over last 7 days
      logDate.setHours(baseDate.getHours() - (i * 2))

      const status = Math.random() > 0.08 ? 'success' : 'failure' // 8% failure rate
      const model = models[i % models.length]
      const action = actions[i % actions.length]
      
      const promptTokens = status === 'success' ? Math.floor(Math.random() * 1500) + 500 : 0
      const completionTokens = status === 'success' ? Math.floor(Math.random() * 800) + 200 : 0
      const totalTokens = promptTokens + completionTokens
      
      const processingTimeMs = status === 'success' ? Math.floor(Math.random() * 1500) + 500 : Math.floor(Math.random() * 300)
      const errorMessage = status === 'failure' ? 'API rate limit exceeded or connection timed out' : undefined
      
      const pricing = status === 'success'
        ? estimateCost({ model, usage: { promptTokens, completionTokens, totalTokens } })
        : { cost: null, pricingSource: 'unknown' }

      await AILog.create({
        model,
        action,
        tokensUsed: {
          promptTokens,
          completionTokens,
          totalTokens
        },
        usageAvailable: status === 'success',
        processingTimeMs,
        status,
        errorMessage,
        costEstimate: pricing.cost,
        pricingSource: pricing.pricingSource,
        createdAt: logDate
      })
    }
  }

  res.status(200).json({
    success: true,
    message: 'Mock analytical and audit data successfully seeded!'
  })
})

export const isSensitiveConfigKey = (key) => {
  if (!key || typeof key !== 'string') return false
  const upper = key.toUpperCase()
  return (
    upper.endsWith('_KEY') ||
    upper.endsWith('_TOKEN') ||
    upper.endsWith('_SECRET') ||
    upper.endsWith('_PASSWORD') ||
    upper.endsWith('_PASS') ||
    upper.endsWith('_CREDENTIALS') ||
    upper.includes('SECRET') ||
    upper.includes('APIKEY') ||
    upper.includes('API_KEY') ||
    upper.includes('TOKEN') ||
    upper.includes('PASSWORD') ||
    upper.includes('CHECKSUM')
  )
}

export const maskSecretValue = (value) => {
  if (!value) return ''
  const str = String(value)
  if (str.length <= 12) {
    return '••••••••'
  }
  return `${str.substring(0, 3)}••••••••${str.substring(str.length - 3)}`
}

const isMaskedSecret = (val) => {
  if (typeof val !== 'string') return false
  return val.includes('...') || val.includes('***') || val.includes('•••') || val.includes('••••')
}

/**
 * @desc    Get system settings (API keys masked)
 * @route   GET /api/admin/config
 * @access  Private (Admin)
 */
export const getConfigs = asyncHandler(async (req, res) => {
  const configs = (await Config.find({})).filter(c => !REMOVED_CONFIG_KEYS.has(c.key))
  
  // Mask API Keys and sensitive settings for security
  const maskedConfigs = configs.map(c => {
    const isSensitive = Boolean(c.sensitive) || isSensitiveConfigKey(c.key)
    return {
      key: c.key,
      value: isSensitive && c.value ? maskSecretValue(c.value) : c.value,
      isSecret: isSensitive,
      isConfigured: isSensitive ? Boolean(c.value) : undefined,
      description: c.description
    }
  })

  res.status(200).json({
    success: true,
    data: maskedConfigs
  })
})

/**
 * @desc    Update system settings
 * @route   PUT /api/admin/config
 * @access  Private (Admin)
 */
// Lightweight format check for legacy Groq keys. Not a substitute for a health check.
const TOKEN_FORMATS = {
  GROQ_API_KEY: /^gsk_[A-Za-z0-9_-]+$/,
}

export const updateConfigs = asyncHandler(async (req, res) => {
  const { settings } = req.body

  if (!Array.isArray(settings) || !settings.length) throw new ErrorResponse('Settings must be a non-empty list', 400)

  const updatedSettings = []
  const logDetails = {}
  const changes = []
  const unknownKeys = []
  const seen = new Set()

  for (const item of settings) {
    const key = item?.key
    if (!key || seen.has(key)) throw new ErrorResponse('Each setting key must be unique', 400)
    seen.add(key)
    if (REMOVED_CONFIG_KEYS.has(key)) {
      throw new ErrorResponse('Hugging Face AI detection has been removed', 410)
    }
    // Normalize whitespace around secrets before validating/storing.
    const value = typeof item.value === 'string' ? item.value.trim() : item.value

    const config = await Config.findOne({ key })
    if (!config) {
      unknownKeys.push(key)
      continue
    }

    const isSensitive = Boolean(config.sensitive) || isSensitiveConfigKey(key)
    if (isSensitive && isMaskedSecret(value)) {
      continue
    }

    // Validate provider-specific format; empty values clear the key.
    const expected = TOKEN_FORMATS[key]
    if (expected && value && !expected.test(value)) {
      throw new ErrorResponse(`Value for ${key} does not match the expected format`, 400)
    }

    const oldValue = config.value
    const storedValue = isSensitive && value ? encryptSecret(String(value)) : value
    config.value = storedValue
    const validation = config.validateSync?.()
    if (validation) throw validation
    changes.push({ config, oldValue, storedValue })

    updatedSettings.push({
      key,
      value: isSensitive && value ? maskSecretValue(value) : value,
      isSecret: isSensitive,
    })
    logDetails[key] = { from: oldValue ? 'configured' : 'empty', to: value ? 'updated' : 'empty' }
  }

  if (unknownKeys.length > 0) {
    throw new ErrorResponse(`Unknown config keys: ${unknownKeys.join(', ')}`, 422)
  }

  const saveChanges = async (session) => {
    for (const { config, storedValue } of changes) {
      config.value = storedValue
      await config.save(session ? { session } : undefined)
    }
  }

  let savedTransactionally = false
  if (changes.length > 1 && mongoose.connection.readyState === 1) {
    const session = await mongoose.startSession()
    try {
      await session.withTransaction(() => saveChanges(session))
      savedTransactionally = true
    } catch (error) {
      const unsupported = error.code === 20 || /Transaction numbers are only allowed|Transaction is not supported/.test(error.message || '')
      if (!unsupported) throw error
    } finally {
      await session.endSession()
    }
  }
  if (!savedTransactionally) {
    try {
      await saveChanges(null)
    } catch (error) {
      const rollbackResults = await Promise.allSettled(changes.map(async ({ config, oldValue }) => {
        config.value = oldValue
        await config.save()
      }))
      const failedRollbacks = rollbackResults
        .map((r, idx) => (r.status === 'rejected' ? changes[idx]?.config?.key : null))
        .filter(Boolean)
      if (failedRollbacks.length > 0) {
        console.error('[ADMIN] Config rollback failed for keys:', failedRollbacks.join(', '))
        await AuditLog.create({
          user: req.user._id,
          actorName: req.user.name || '',
          actorEmail: req.user.email || '',
          actorRole: req.user.role || '',
          action: 'UPDATE_SYSTEM_CONFIG',
          targetType: 'SystemConfig',
          details: { rollbackFailedKeys: failedRollbacks, error: error.message || 'Save failed' },
        }).catch(() => {})
      }
      throw error
    }
  }

  // Log this config update action into AuditLog
  try {
    await AuditLog.create({
      user: req.user._id,
      actorName: req.user.name || '',
      actorEmail: req.user.email || '',
      actorRole: req.user.role || '',
      action: 'UPDATE_SYSTEM_CONFIG',
      targetType: 'SystemConfig',
      details: logDetails
    })
  } catch (auditErr) {
    console.error('Failed to write audit log for config update:', auditErr.message)
  }

  res.status(200).json({
    success: true,
    message: 'System settings updated successfully',
    data: updatedSettings
  })
})

/**
 * @desc    Get paginated AI logs
 * @route   GET /api/admin/ai/logs
 * @access  Private (Admin)
 */
export const getAILogs = asyncHandler(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1)
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 10))
  const skip = (page - 1) * limit

  const { status, action, model, startDate, endDate } = req.query
  const query = {}

  if (status) query.status = status
  if (action) query.action = action
  if (model) query.model = model

  if (startDate || endDate) {
    query.createdAt = {}
    if (startDate) query.createdAt.$gte = parseDateFilter(startDate)
    if (endDate) query.createdAt.$lte = parseDateFilter(endDate)
  }

  const total = await AILog.countDocuments(query)
  const logs = await AILog.find(query)
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit)

  res.status(200).json({
    success: true,
    pagination: {
      total,
      page,
      limit,
      pages: Math.ceil(total / limit)
    },
    data: logs
  })
})

/**
 * @desc    Get AI monitoring dashboard charts & metrics
 * @route   GET /api/admin/ai/monitoring
 * @access  Private (Admin)
 */
export const getAIMonitoringAnalytics = asyncHandler(async (req, res) => {
  const totalCalls = await AILog.countDocuments()
  const successCalls = await AILog.countDocuments({ status: 'success' })
  const failedCalls = await AILog.countDocuments({ status: 'failure' })
  
  const successRate = totalCalls > 0 ? Math.round((successCalls / totalCalls) * 100) : 100
  
  const tokenStats = await AILog.aggregate([
    {
      $group: {
        _id: null,
        totalTokens: { $sum: '$tokensUsed.totalTokens' },
        totalCost: { $sum: '$costEstimate' },
        avgTime: { $avg: '$processingTimeMs' }
      }
    }
  ])
  
  const totalTokens = tokenStats[0]?.totalTokens || 0
  const totalCost = tokenStats[0]?.totalCost || 0
  const avgResponseTime = Math.round(tokenStats[0]?.avgTime || 0)
  
  // Daily stats for the last 7 days
  const sevenDaysAgo = new Date()
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7)
  sevenDaysAgo.setHours(0, 0, 0, 0)
  
  const dailyStats = await AILog.aggregate([
    {
      $match: {
        createdAt: { $gte: sevenDaysAgo }
      }
    },
    {
      $group: {
        _id: {
          $dateToString: { format: "%Y-%m-%d", date: "$createdAt" }
        },
        calls: { $sum: 1 },
        success: {
          $sum: { $cond: [{ $eq: ["$status", "success"] }, 1, 0] }
        },
        failed: {
          $sum: { $cond: [{ $eq: ["$status", "failure"] }, 1, 0] }
        },
        tokens: { $sum: "$tokensUsed.totalTokens" },
        cost: { $sum: "$costEstimate" }
      }
    },
    { $sort: { _id: 1 } }
  ])
  
  res.status(200).json({
    success: true,
    data: {
      metrics: {
        totalCalls,
        successCalls,
        failedCalls,
        successRate,
        totalTokens,
        totalCost: Math.round(totalCost * 10000) / 10000,
        avgResponseTime
      },
      dailyStats
    }
  })
})

/**
 * @desc    Force-release a stale admin user mutation lock after process crash
 * @route   DELETE /api/admin/mutation-lock
 * @access  Private (Admin)
 */
export const forceReleaseMutationLock = asyncHandler(async (req, res) => {
  const result = await forceReleaseAdminMutationLock()
  await logAction(req.user._id, 'ADMIN_FORCE_RELEASE_MUTATION_LOCK', 'SystemConfig', 'admin-user-mutations', {
    released: result.released,
    previousOwner: result.previousOwner,
  })
  res.status(200).json({
    success: true,
    released: result.released,
    previousOwner: result.previousOwner,
  })
})

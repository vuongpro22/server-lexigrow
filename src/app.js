import 'dotenv/config'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
import express from 'express'
import cors from 'cors'
import mongoose from 'mongoose'

import errorHandler from './middleware/error.middleware.js'
import { parseCookies } from './utils/cookie.js'

const app = express()
const proxyHops = Number(process.env.TRUST_PROXY_HOPS || 0)
if (!Number.isInteger(proxyHops) || proxyHops < 0) {
  throw new Error('TRUST_PROXY_HOPS must be a non-negative integer')
}
app.set('trust proxy', proxyHops)

// Body parser
app.use(express.json({ limit: '10mb' }))
app.use(express.urlencoded({ extended: true }))
app.use((req, res, next) => {
  req.body ??= {}
  res.set('X-Content-Type-Options', 'nosniff')
  req.cookies = parseCookies(req.headers.cookie)
  next()
})
//
// CORS
app.use(cors({
  origin: globalThis.process.env.CLIENT_URL || 'http://localhost:5173',
  credentials: true,
}))

// Health check
app.get('/api/health', (req, res) => {
  res.json({ success: true, message: 'LexiGrow API is running', timestamp: new Date().toISOString() })
})
if (process.env.NODE_ENV === 'test' && process.env.EXPOSE_TEST_DATABASE_IDENTITY === 'true') {
  app.get('/api/test/identity', (req, res) => {
    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({ error: 'Test database identity is unavailable' })
    }
    const database = mongoose.connection.name
    const databaseHost = mongoose.connection.host
    const databasePort = String(mongoose.connection.port)
    if (database !== 'lexigrow_dev5_test'
      || !['localhost', '127.0.0.1', '::1'].includes(databaseHost)) {
      return res.status(503).json({ error: 'Test database identity is unavailable' })
    }
    res.json({ environment: 'test', database, databaseHost, databasePort })
  })
}

// Route files
import authRoutes from './routes/auth.routes.js'
import essayRoutes from './routes/essay.routes.js'
import analysisRoutes from './routes/analysis.routes.js'
import vocabularyRoutes from './routes/vocabulary.routes.js'
import progressRoutes from './routes/progress.routes.js'
import goalsRoutes from './routes/goals.routes.js'
import classRoutes from './routes/class.routes.js'
import teacherRoutes from './routes/teacher.routes.js'
import feedbackRoutes from './routes/feedback.routes.js'
import alertRoutes from './routes/alert.routes.js'
import promptRoutes from './routes/prompt.routes.js'
import profileRoutes from './routes/profile.routes.js'
import parentRoutes from './routes/parent.routes.js'
import notificationRoutes from './routes/notification.routes.js'
import commentRoutes from './routes/comment.routes.js'
import adminRoutes from './routes/admin.routes.js'
import assignmentRoutes from './routes/assignment.routes.js'
import globalVocabularyRoutes from './routes/globalVocabulary.routes.js'
import learningSetRoutes from './routes/learningSet.routes.js'
import learningSessionRoutes from './routes/learningSession.routes.js'
import writingPromptRoutes from './routes/writingPrompt.routes.js'
import practiceQuestionRoutes from './routes/practiceQuestion.routes.js'
import practiceRoutes from './routes/practice.routes.js'
import srsRoutes from './routes/srs.routes.js'
import gardenRoutes from './routes/garden.routes.js'
import dailyQuestRoutes from './routes/dailyQuest.routes.js'
import gameRoutes from './routes/game.routes.js'
import gamificationRoutes from './routes/gamification.routes.js'
import paymentRoutes from './routes/payment.routes.js'
import adminPricingRoutes from './routes/admin.pricing.routes.js'
import chatRoutes from './routes/chat.routes.js'
import aiProviderRoutes from './routes/aiProvider.routes.js'
import internalAiRelayRoutes from './routes/internalAiRelay.routes.js'

app.use('/api/auth', authRoutes)
app.use('/api/essays', essayRoutes)
app.use('/api/essays', analysisRoutes)
app.use('/api/vocabulary', vocabularyRoutes)
app.use('/api/progress', progressRoutes)
app.use('/api/goals', goalsRoutes)
app.use('/api/classes', classRoutes)
app.use('/api/teacher', teacherRoutes)
app.use('/api/feedback', feedbackRoutes)
app.use('/api/alerts', alertRoutes)
app.use('/api/prompts', promptRoutes)
app.use('/api/profile', profileRoutes)
app.use('/api/parent', parentRoutes)
app.use('/api/notifications', notificationRoutes)
app.use('/api/comments', commentRoutes)
app.use('/api/admin', adminRoutes)
app.use('/api/admin/ai/providers', aiProviderRoutes)
app.use('/internal/ai/v1', internalAiRelayRoutes)
app.use('/api/admin/global-vocabulary', globalVocabularyRoutes)
app.use('/api/admin/pricing', adminPricingRoutes)
app.use('/api/assignments', assignmentRoutes)
app.use('/api/learning-sets', learningSetRoutes)
app.use('/api/sessions', learningSessionRoutes)
app.use('/api/learning-session', learningSessionRoutes)
app.use('/api/sessions', writingPromptRoutes)
app.use('/api/sessions', practiceQuestionRoutes)
app.use('/api/practice', practiceRoutes)
app.use('/api/srs', srsRoutes)
app.use('/api/garden', gardenRoutes)
app.use('/api/daily-quests', dailyQuestRoutes)
app.use('/api/games', gameRoutes)
app.use('/api/gamification', gamificationRoutes)
app.use('/api/payments', paymentRoutes)
app.use('/api/subscriptions', paymentRoutes)
app.use('/api/chat', chatRoutes)

// Serve built frontend assets in production (Docker container or dist build)
const distPath = path.resolve(__dirname, '../../dist')
if (fs.existsSync(distPath)) {
  // Static assets with hash in filename can be cached long-term
  app.use('/assets', express.static(path.join(distPath, 'assets'), {
    maxAge: '1y',
    immutable: true
  }))
  app.use(express.static(distPath, {
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('.html')) {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate')
        res.setHeader('Pragma', 'no-cache')
        res.setHeader('Expires', '0')
      }
    }
  }))
  app.use((req, res, next) => {
    if (req.method === 'GET' && !req.path.startsWith('/api')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate')
      res.setHeader('Pragma', 'no-cache')
      res.setHeader('Expires', '0')
      return res.sendFile(path.join(distPath, 'index.html'))
    }
    next()
  })
}

// Error handler (must be after routes)
app.use(errorHandler)

export default app

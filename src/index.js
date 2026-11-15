import 'dotenv/config'
import app from './app.js'
import connectDB from './config/db.js'
import { initSocket } from './services/socket.service.js'
import { scheduleEarlyWarningScan } from './services/earlyWarning.scheduler.js'
import { scheduleSubscriptionReminders } from './services/subscriptionReminder.scheduler.js'
import { schedulePaymentReconciliation } from './services/paymentReconciliation.scheduler.js'
import { scheduleAIAnalysisHistoryOutbox } from './services/aiAnalysisHistoryOutbox.scheduler.js'
import { scheduleGameSessionCleanup } from './services/gameSession.scheduler.js'
import { startVocabularyEnrichmentWorker } from './services/vocabularyEnrichment.service.js'
import { ensureDefaultLevelRules } from './services/gamification.service.js'
import { seedDefaultData } from './services/seedBootstrap.service.js'
import { startXpOutboxWorker } from './services/learningXp.service.js'
import mongoose from 'mongoose'

if (process.env.NODE_ENV !== 'test') {
  await connectDB()
  // New unique indexes are part of correctness, not just an optimization.
  await Promise.all(['LearningSession', 'LearningOperation', 'PracticeAttempt', 'ReviewEvent', 'EssayRevision', 'WordUsageEvidence', 'DailyQuest', 'XpEvent', 'XpQuota', 'XpAwardOutbox', 'GamificationProfile', 'LevelRule', 'RewardGrant', 'GameSession', 'GameResult', 'TeacherQuotaLock', 'GardenWaterLog', 'AIAnalysisHistory', 'AIQuotaBucket', 'Subscription'].map(name => mongoose.model(name).createIndexes()))
  await ensureDefaultLevelRules()
  await seedDefaultData()
  const server = app.listen(process.env.PORT || 5000, () => console.log('LexiGrow API started'))
  initSocket(server)
  scheduleEarlyWarningScan()
  scheduleSubscriptionReminders()
  schedulePaymentReconciliation()
  scheduleAIAnalysisHistoryOutbox()
  scheduleGameSessionCleanup()
  startVocabularyEnrichmentWorker()
  startXpOutboxWorker()
}

export default app

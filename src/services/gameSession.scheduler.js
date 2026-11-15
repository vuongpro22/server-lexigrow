import cron from 'node-cron'
import GameSession from '../models/GameSession.js'

export const DEFAULT_GAME_SESSION_CLEANUP_CRON = '*/10 * * * *'
// A session is abandoned once its 30 minute window passed and no heartbeat
// arrived for another hour. Active play keeps extending expiresAt instead.
const STALE_AFTER_MS = 60 * 60 * 1000

export async function runGameSessionCleanup(now = new Date()) {
  const cutoff = new Date(now.getTime() - STALE_AFTER_MS)
  const result = await GameSession.updateMany(
    { status: 'active', expiresAt: { $lt: cutoff } },
    { $set: { status: 'expired' } },
  )
  return { expired: result.modifiedCount || 0 }
}

export const scheduleGameSessionCleanup = () => {
  const expression =
    globalThis.process.env.GAME_SESSION_CLEANUP_CRON || DEFAULT_GAME_SESSION_CLEANUP_CRON

  if (!cron.validate(expression)) {
    throw new Error(`Invalid GAME_SESSION_CLEANUP_CRON expression: ${expression}`)
  }

  const task = cron.schedule(
    expression,
    async () => {
      try {
        const summary = await runGameSessionCleanup()
        if (summary.expired) console.log('[GameSession] Expired stale sessions:', summary)
      } catch (error) {
        console.error('[GameSession] Cleanup failed:', error)
      }
    },
    { name: 'game-session-cleanup', noOverlap: true },
  )

  console.log(`[GameSession] Scheduled cleanup (${expression})`)
  return task
}

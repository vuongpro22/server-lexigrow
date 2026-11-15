import ErrorResponse from '../utils/ErrorResponse.js'
import { getUserEffectiveTier } from '../services/tier.service.js'

const TIER_RANK = { free: 0, plus: 1, pro: 2, ultra: 3 }

// Foundational levels stay readable on the Free plan; B2/C1 unlock with a paid
// tier. Level, not creation order, so admin edits cannot silently move the line.
export const FREE_LEARNING_SET_LEVELS = ['A2', 'B1']

const FEATURE_MIN_TIER = {
  learning_set_library: 'plus',
}

export const tierSatisfies = (tier, minTier) => (TIER_RANK[tier] ?? 0) >= (TIER_RANK[minTier] ?? 0)

export async function effectiveTierFor(req) {
  if (req.entitlementTier) return req.entitlementTier
  req.entitlementTier = await getUserEffectiveTier(req.user)
  return req.entitlementTier
}

export function requireEntitlement(featureKey) {
  const minTier = FEATURE_MIN_TIER[featureKey]
  if (!minTier) throw new Error(`Unknown entitlement feature: ${featureKey}`)
  return async (req, res, next) => {
    try {
      const tierInfo = await effectiveTierFor(req)
      if (!tierSatisfies(tierInfo?.tier, minTier)) {
        return next(new ErrorResponse('This feature requires a paid plan', 403, 'FEATURE_REQUIRES_PAID_PLAN'))
      }
      next()
    } catch (err) {
      next(err)
    }
  }
}

// Shared by listing, explore and slug lookup so a Free account cannot reach a
// locked set by requesting its slug directly.
export async function learningSetLibraryFilter(req) {
  const base = { status: 'published' }
  if (!req.user || req.user.role === 'admin') {
    return req.user ? base : { ...base, level: { $in: FREE_LEARNING_SET_LEVELS } }
  }
  const tierInfo = await effectiveTierFor(req)
  if (tierSatisfies(tierInfo?.tier, FEATURE_MIN_TIER.learning_set_library)) return base
  return { ...base, level: { $in: FREE_LEARNING_SET_LEVELS } }
}

// A locked set answers exactly like a missing one so the library boundary is not
// disclosed through the API.
export async function isLearningSetVisible(req, learningSet) {
  const filter = await learningSetLibraryFilter(req)
  return !filter.level || filter.level.$in.includes(learningSet.level)
}

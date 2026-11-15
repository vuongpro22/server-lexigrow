export const TIER_RANK = { free: 0, plus: 1, pro: 2, ultra: 3 }

export const tierRank = (tier) => TIER_RANK[tier] ?? 0

export const limitRank = (limit) => {
  if (limit === -1 || limit >= 9999) return Number.POSITIVE_INFINITY
  return Number.isFinite(limit) ? limit : 0
}

/**
 * Compare two normalized effective-tier candidates (PAY-06 / PAY-07).
 * Order: tier rank -> further expiration -> higher quota -> teacher_sponsored tie -> stable key.
 */
export const isBetterEffectiveTier = (candidate, current) => {
  if (!current) return true
  const rankDifference = tierRank(candidate.tier) - tierRank(current.tier)
  if (rankDifference) return rankDifference > 0

  const candidateExpiry = new Date(candidate.expiresAt || 0).getTime()
  const currentExpiry = new Date(current.expiresAt || 0).getTime()
  if (candidateExpiry !== currentExpiry) return candidateExpiry > currentExpiry

  const candidateQuota = limitRank(candidate.dailyAiEssayLimit)
  const currentQuota = limitRank(current.dailyAiEssayLimit)
  if (candidateQuota !== currentQuota) return candidateQuota > currentQuota

  if (candidate.source !== current.source) {
    return candidate.source === 'teacher_sponsored'
  }
  return false
}

const compareActiveSubscriptions = (left, right) => {
  const rankDiff = tierRank(right?.tier) - tierRank(left?.tier)
  if (rankDiff) return rankDiff

  const expiryDiff = new Date(right?.endDate || 0).getTime() - new Date(left?.endDate || 0).getTime()
  if (expiryDiff) return expiryDiff

  const leftQuota = Number.isFinite(left?.maxSponsoredStudents) ? left.maxSponsoredStudents : -1
  const rightQuota = Number.isFinite(right?.maxSponsoredStudents) ? right.maxSponsoredStudents : -1
  if (rightQuota !== leftQuota) return rightQuota - leftQuota

  return String(left?._id || '').localeCompare(String(right?._id || ''))
}

/**
 * Pick the highest-priority active subscription from a list of Subscription docs.
 */
export function selectBestActiveSubscription(subscriptions = []) {
  if (!Array.isArray(subscriptions) || subscriptions.length === 0) return null
  return [...subscriptions].sort(compareActiveSubscriptions)[0]
}

/**
 * Query active subscriptions matching filter and pick the highest tier -> furthest expiry -> deterministic _id.
 * Falls back to findOne when tests only mock Subscription.findOne.
 */
export async function findBestActiveSubscription(SubscriptionModel, filter) {
  if (typeof SubscriptionModel.find === 'function') {
    const query = SubscriptionModel.find(filter)
    const rows = typeof query?.sort === 'function'
      ? await query.sort({ endDate: -1, _id: 1 })
      : await query
    if (Array.isArray(rows)) return selectBestActiveSubscription(rows)
  }

  const singleQuery = SubscriptionModel.findOne(filter)
  return typeof singleQuery?.sort === 'function'
    ? singleQuery.sort({ endDate: -1, _id: 1 })
    : singleQuery
}

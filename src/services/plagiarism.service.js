import Essay from '../models/Essay.js'

/**
 * Clean text and tokenize it
 * @param {string} text 
 * @returns {string[]}
 */
const tokenize = (text) => {
  if (!text) return []
  return text
    .toLowerCase()
    .replace(/[^\w\s']/g, '') // remove punctuation except single quotes
    .split(/\s+/)
    .filter(Boolean)
}

/**
 * Apply `.limit()` + `.lean()` when the query builder supports it, otherwise
 * return the query/promise unchanged (keeps unit-test doubles working).
 */
const finalizeQuery = (query, limit, sort) => {
  if (query && typeof query.lean === 'function') {
    // Without a sort, limit() keeps whichever documents MongoDB returns first
    // (usually the oldest), so recent essays would never be compared.
    const ordered = sort && typeof query.sort === 'function' ? query.sort(sort) : query
    const bounded = typeof ordered.limit === 'function' ? ordered.limit(limit) : ordered
    return bounded.lean()
  }
  return query
}

/**
 * Generate N-Grams from tokens list
 * @param {string[]} tokens 
 * @param {number} n 
 * @returns {Set<string>}
 */
const getNGrams = (tokens, n = 3) => {
  const nGrams = new Set()
  for (let i = 0; i <= tokens.length - n; i++) {
    nGrams.add(tokens.slice(i, i + n).join(' '))
  }
  return nGrams
}

/**
 * Compute Jaccard Similarity between two sets
 * @param {Set<any>} setA 
 * @param {Set<any>} setB 
 * @returns {number}
 */
const computeJaccard = (setA, setB) => {
  if (setA.size === 0 || setB.size === 0) return 0
  
  let intersectionCount = 0
  for (const item of setA) {
    if (setB.has(item)) {
      intersectionCount++
    }
  }
  
  const unionSize = setA.size + setB.size - intersectionCount
  return unionSize > 0 ? intersectionCount / unionSize : 0
}

/**
 * Check if the essay content matches any other submitted or reviewed essay
 * @param {string} newEssayId 
 * @param {string} text 
 * @returns {Promise<{isPlagiarized: boolean, similarityScore: number, matchedEssay: string|null}>}
 */
export const checkCrossStudentPlagiarism = async (newEssayId, text, studentId) => {
  const started = Date.now()
  try {
    const newTokens = tokenize(text)
    if (newTokens.length < 5) {
      return { isPlagiarized: false, similarityScore: 0, matchedEssay: null, status: 'insufficient_text', comparedEssayCount: 0 }
    }

    const new3Grams = getNGrams(newTokens, 3)
    if (new3Grams.size === 0) {
      return { isPlagiarized: false, similarityScore: 0, matchedEssay: null, status: 'insufficient_text', comparedEssayCount: 0 }
    }

    // LG-13: bound the comparison set and skip hydration via .lean().
    // NOTE: the comparison itself is still O(N) per new essay (N <= 200 here).
    const essaysQuery = Essay.find({
      _id: { $ne: newEssayId },
      ...(studentId ? { student: { $exists: true, $ne: studentId } } : {}),
      status: { $in: ['submitted', 'reviewed'] }
    }).select('_id title content')
    const otherEssays = await finalizeQuery(essaysQuery, 200, { _id: -1 })

    if (!otherEssays?.length) {
      return { isPlagiarized: false, similarityScore: 0, matchedEssay: null, status: 'no_comparison_data', comparedEssayCount: 0 }
    }

    let highestScore = 0
    let bestMatch = null

    for (const essay of otherEssays) {
      const tokens = tokenize(essay.content)
      const grams = getNGrams(tokens, 3)
      
      const similarity = computeJaccard(new3Grams, grams)
      if (similarity > highestScore) {
        highestScore = similarity
        bestMatch = essay
      }
    }

    // This is only a peer-text overlap signal; it cannot establish plagiarism.
    const threshold = 0.25
    const isPlagiarized = highestScore >= threshold

    const durationSec = ((Date.now() - started) / 1000).toFixed(2)
    console.log(`[Plagiarism Check] ⏱️ Kiểm tra đạo văn chéo hoàn tất trong ${durationSec}s (${otherEssays?.length || 0} bài so sánh)`)

    return {
      isPlagiarized,
      similarityScore: Math.round(highestScore * 100) / 100, // round to 2 decimals
      matchedEssay: isPlagiarized && bestMatch ? bestMatch._id : null,
      status: 'complete',
      comparedEssayCount: otherEssays?.length || 0
    }
  } catch (err) {
    const durationSec = ((Date.now() - started) / 1000).toFixed(2)
    console.error(`[Plagiarism Check] ❌ Lỗi kiểm tra đạo văn sau ${durationSec}s:`, err.message)
    return { isPlagiarized: false, similarityScore: null, matchedEssay: null, status: 'unavailable', comparedEssayCount: 0 }
  }
}

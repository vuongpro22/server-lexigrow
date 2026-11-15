import mongoose from 'mongoose'
import { randomUUID } from 'node:crypto'
import Vocabulary from '../models/Vocabulary.js'
import GameResult from '../models/GameResult.js'
import GameSession from '../models/GameSession.js'
import ErrorResponse from '../utils/ErrorResponse.js'
import { GAME_CONFIG, GAME_KEYS } from '../constants/gamification.js'
import { awardGameXp } from './gamification.service.js'

const SESSION_TTL_MS = 30 * 60 * 1000
const MAX_MATCHING_ATTEMPTS = 10_000
const FALLBACK_WORDS = [
  { word: 'Accolade', definition: 'An award or privilege granted as special honor or recognition of merit.', exampleSentence: 'The word accolade describes an award granted as special honor.' },
  { word: 'Benevolent', definition: 'Well meaning and kindly; serving a charitable purpose.', exampleSentence: 'A benevolent person is kind and wishes to help others.' },
  { word: 'Capricious', definition: 'Given to sudden and unaccountable changes of mood or behavior.', exampleSentence: 'A capricious decision changes suddenly and without a clear reason.' },
  { word: 'Diligent', definition: 'Having or showing care and conscientiousness in one’s work or duties.', exampleSentence: 'A diligent student works carefully and consistently.' },
  { word: 'Eloquent', definition: 'Fluent or persuasive in speaking or writing.', exampleSentence: 'An eloquent speaker expresses ideas clearly and persuasively.' },
  { word: 'Frugal', definition: 'Sparing or economical with regard to money or food.', exampleSentence: 'A frugal shopper spends money carefully.' },
  { word: 'Garrulous', definition: 'Excessively talkative, especially on trivial matters.', exampleSentence: 'A garrulous guest talks excessively about trivial matters.' },
  { word: 'Hypothesis', definition: 'A proposed explanation made on the basis of limited evidence.', exampleSentence: 'The scientist tested a hypothesis using evidence.' },
]

function shuffled(items) {
  const result = [...items]
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[result[i], result[j]] = [result[j], result[i]]
  }
  return result
}

function publicChallenges(session) {
  return (session.challenges || []).map(challenge => ({
    id: challenge.id,
    prompt: challenge.prompt,
    letters: challenge.letters,
    options: (challenge.options || []).map(({ id, text }) => ({ id, text })),
    cards: (challenge.cards || []).map(({ id, type, text }) => ({ id, type, text })),
  }))
}

export function normalizeGameConfig(gameKey, input = {}) {
  const meta = GAME_CONFIG[gameKey]
  if (!meta) throw new ErrorResponse('Unknown game', 400)
  const config = { ...meta.defaults }
  for (const [key, allowed] of Object.entries(meta.allowed)) {
    const candidate = input?.[key]
    if (candidate !== undefined && allowed.includes(candidate)) config[key] = candidate
  }
  return config
}

export function publicGameSession(session) {
  return {
    sessionId: String(session._id),
    gameKey: session.gameKey,
    config: session.config || {},
    expectedRounds: session.expectedRounds,
    startedAt: session.startedAt,
    expiresAt: session.expiresAt,
    challenges: publicChallenges(session),
  }
}

export function publicGameResult(result) {
  return {
    id: String(result._id),
    gameKey: result.gameKey,
    score: result.score,
    correct: result.correct,
    total: result.total,
    durationMs: result.durationMs,
    accuracy: result.accuracy,
    xpEarned: result.xpEarned,
    finishedAt: result.finishedAt,
  }
}

async function createChallengePlan(studentId, gameKey, config) {
  const count = GAME_CONFIG[gameKey].expectedRounds(config)
  const owned = await Vocabulary.find({ student: studentId })
    .select('word definition exampleSentence ipa')
    .limit(150)
    .lean()
  const pool = owned.length >= 4 ? owned : FALLBACK_WORDS
  const selected = []
  while (selected.length < count) selected.push(...shuffled(pool).slice(0, count - selected.length))

  return selected.slice(0, count).map(item => {
    const id = randomUUID()
    const alternatives = shuffled(pool.filter(value => value.word.toLowerCase() !== item.word.toLowerCase())).slice(0, 3)
    const choiceItems = shuffled([item, ...alternatives])
    const options = choiceItems.map(value => ({ id: randomUUID(), text: value.word }))
    const correctOption = options.find(option => option.text.toLowerCase() === item.word.toLowerCase())
    const sentence = item.exampleSentence || item.definition || `Use the word ${item.word} in context.`
    const escapedWord = item.word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const prompt = gameKey === 'filler'
      ? sentence.replace(new RegExp(escapedWord, 'ig'), '_____')
      : item.definition || sentence
    const challenge = {
      id,
      word: item.word,
      definition: item.definition || '',
      prompt,
      answerId: correctOption?.id,
      options,
    }
    if (gameKey === 'scramble') {
      challenge.letters = shuffled(item.word.toUpperCase().split(''))
    }
    if (gameKey === 'matching') {
      challenge.cards = shuffled([
        { id: `${id}:word`, type: 'word', text: item.word },
        { id: `${id}:definition`, type: 'definition', text: item.definition || '' },
      ])
      challenge.answerCardIds = [`${id}:word`, `${id}:definition`]
    }
    return challenge
  })
}

export async function startGameSession(studentId, gameKey, inputConfig = {}) {
  if (!GAME_KEYS.includes(gameKey)) throw new ErrorResponse('Unknown game', 400)
  const config = normalizeGameConfig(gameKey, inputConfig)
  const now = new Date()
  await GameSession.updateMany(
    { student: studentId, gameKey, status: 'active' },
    { $set: { status: 'expired' } },
  )
  const challenges = await createChallengePlan(studentId, gameKey, config)
  const session = await GameSession.create({
    student: studentId,
    gameKey,
    config,
    expectedRounds: challenges.length,
    challenges,
    answers: [],
    status: 'active',
    startedAt: now,
    expiresAt: new Date(now.getTime() + SESSION_TTL_MS),
  })
  return publicGameSession(session)
}

export async function recordGameAnswer(studentId, gameKey, sessionId, body = {}) {
  if (!mongoose.isValidObjectId(sessionId)) throw new ErrorResponse('Game session not found', 404)
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ErrorResponse('Invalid game answer', 400)
  const { challengeId, optionId, text, cardIds } = body
  const session = await GameSession.findOne({
    _id: sessionId,
    student: studentId,
    gameKey,
    status: 'active',
    expiresAt: { $gt: new Date() },
  })
  if (!session) throw new ErrorResponse('Game session is not active', 409)
  const index = session.answers.length
  const challenge = session.challenges[index]
  if (!challenge || challenge.id !== challengeId) throw new ErrorResponse('Answer challenges in order', 409)
  let correct = false
  if (gameKey === 'matching') {
    if (!Array.isArray(cardIds) || cardIds.length !== 2 || cardIds.some(id => typeof id !== 'string')) {
      throw new ErrorResponse('Invalid matching cards', 400)
    }
    const submitted = [...cardIds].sort()
    const expected = [...challenge.answerCardIds].sort()
    correct = submitted[0] === expected[0] && submitted[1] === expected[1]
  } else if (gameKey === 'scramble') {
    correct = typeof text === 'string' && text.trim().toLowerCase() === challenge.word.toLowerCase()
  } else {
    if (typeof optionId !== 'string' || !challenge.options.some(option => option.id === optionId)) {
      throw new ErrorResponse('Invalid answer option', 400)
    }
    correct = optionId === challenge.answerId
  }
  const answer = { challengeId, correct, answeredAt: new Date() }
  const updated = await GameSession.findOneAndUpdate(
    { _id: session._id, student: studentId, status: 'active', [`answers.${index}`]: { $exists: false } },
    { $push: { answers: answer } },
    { returnDocument: 'after' },
  )
  if (!updated) {
    const latest = await GameSession.findById(session._id).lean()
    const previous = latest?.answers?.[index]
    if (previous?.challengeId === challengeId) {
      return { challengeId, correct: previous.correct, nextChallenge: publicChallenges(latest)[index + 1] || null }
    }
    throw new ErrorResponse('Challenge answer already submitted', 409)
  }
  return { challengeId, correct, nextChallenge: publicChallenges(updated)[index + 1] || null }
}

function serverFinishPayload(session) {
  const challenges = session.challenges || []
  const answers = session.answers || []
  if (answers.length !== challenges.length) throw new ErrorResponse('Answer all game challenges before finishing', 409)
  const correct = answers.filter(answer => answer.correct).length
  const total = challenges.length
  let bestStreak = 0
  let streak = 0
  for (const answer of answers) {
    streak = answer.correct ? streak + 1 : 0
    bestStreak = Math.max(bestStreak, streak)
  }
  const score = session.gameKey === 'matching' ? correct * 100
    : session.gameKey === 'hunter' ? correct * 100
      : correct
  const meta = session.gameKey === 'matching'
    ? { attempts: Math.max(total, answers.length) }
    : session.gameKey === 'hunter'
      ? { roundsCleared: correct, livesRemaining: Math.max(0, 3 - (total - correct)), speedLevel: session.config?.speedLevel || 'medium' }
      : { bestStreak }
  return {
    score,
    correct,
    total,
    durationMs: Math.min(SESSION_TTL_MS, Math.max(0, Date.now() - new Date(session.startedAt).getTime())),
    meta,
  }
}

async function awardGameXpWithDuplicateRetry(...args) {
  let lastError
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await awardGameXp(...args)
    } catch (error) {
      if (error?.code !== 11000) throw error
      lastError = error
    }
  }
  throw lastError
}

async function completeGameResult(studentId, session, result, replayed) {
  const reward = await awardGameXpWithDuplicateRetry(
    studentId,
    session._id,
    session.gameKey,
    result.correct,
    result.total,
    result.meta || {},
  )
  if (reward.xpEarned > 0) {
    await GameResult.updateOne({ _id: result._id }, { $set: { xpEarned: reward.xpEarned } })
    result.xpEarned = reward.xpEarned
  }
  if (session.status === 'finishing') {
    await GameSession.updateOne(
      { _id: session._id, student: studentId, status: 'finishing' },
      { $set: { status: 'finished', finishedAt: new Date() } },
    )
  }
  return { result: publicGameResult(result), ...reward, replayed }
}

export async function finishGameSession(studentId, gameKey, sessionId, _body = {}) {
  if (!mongoose.isValidObjectId(sessionId)) throw new ErrorResponse('Game session not found', 404)
  if (!GAME_KEYS.includes(gameKey)) throw new ErrorResponse('Unknown game', 400)
  let session = await GameSession.findOne({ _id: sessionId, student: studentId, gameKey })
  if (!session) throw new ErrorResponse('Game session not found', 404)
  if (session.status === 'expired') throw new ErrorResponse('This game session has expired. Start a new game.', 410)
  let result = await GameResult.findOne({ session: session._id })
  if (session.status === 'finished' && result) return completeGameResult(studentId, session, result, true)

  if (session.status === 'active') {
    if (session.expiresAt <= new Date()) throw new ErrorResponse('This game session has expired. Start a new game.', 410)
    const payload = session.finishPayload || (session.challenges?.length ? serverFinishPayload(session) : _body)
    if (!payload || !Number.isFinite(payload.total) || !Number.isFinite(payload.correct)) {
      throw new ErrorResponse('Restart this legacy game session to receive server challenges.', 409)
    }
    const claimed = await GameSession.findOneAndUpdate(
      { _id: session._id, student: studentId, gameKey, status: 'active', expiresAt: { $gt: new Date() } },
      { $set: { status: 'finishing', finishPayload: payload, finishingAt: new Date(), finishedAt: null } },
      { returnDocument: 'after' },
    )
    session = claimed || await GameSession.findOne({ _id: sessionId, student: studentId, gameKey })
  } else if (session.status === 'finished' && !result) {
    if (!session.finishPayload) throw new ErrorResponse('Legacy game result cannot be recovered without a saved server result', 409)
    const claimed = await GameSession.findOneAndUpdate(
      { _id: session._id, student: studentId, gameKey, status: 'finished' },
      { $set: { status: 'finishing', finishingAt: new Date(), finishedAt: null } },
      { returnDocument: 'after' },
    )
    session = claimed || await GameSession.findOne({ _id: sessionId, student: studentId, gameKey })
  }

  if (!session) throw new ErrorResponse('Game session not found', 404)
  if (session.status === 'finished') {
    result = await GameResult.findOne({ session: session._id })
    if (result) return completeGameResult(studentId, session, result, true)
    throw new ErrorResponse('This game session is no longer active', 409)
  }
  if (session.status !== 'finishing' || !session.finishPayload) throw new ErrorResponse('This game session is no longer active', 409)
  result = await GameResult.findOne({ session: session._id })
  let replayed = Boolean(result)
  if (!result) {
    const payload = session.finishPayload
    const accuracy = payload.total ? payload.correct / payload.total : 0
    try {
      result = await GameResult.findOneAndUpdate(
        { session: session._id },
        { $setOnInsert: { student: studentId, session: session._id, gameKey, ...payload, accuracy, xpEarned: 0, finishedAt: session.finishingAt || new Date() } },
        { upsert: true, returnDocument: 'after' },
      )
    } catch (error) {
      if (error?.code !== 11000) throw error
      result = await GameResult.findOne({ session: session._id })
      if (!result) throw error
      replayed = true
    }
  }
  if (!result) throw new ErrorResponse('Unable to save game result', 500)
  return completeGameResult(studentId, session, result, replayed)
}

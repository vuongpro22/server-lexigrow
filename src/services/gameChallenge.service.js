import mongoose from 'mongoose'
import { randomUUID } from 'node:crypto'
import GameSession from '../models/GameSession.js'
import GameResult from '../models/GameResult.js'
import Vocabulary from '../models/Vocabulary.js'
import ErrorResponse from '../utils/ErrorResponse.js'
import { GAME_CONFIG, GAME_KEYS } from '../constants/gamification.js'
import { finishGameSession } from './gameSession.service.js'

const SESSION_TTL_MS = 30 * 60 * 1000
const HUNTER_ROUND_MS = 90 * 1000

function shuffle(values) {
  const items = [...values]
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[items[i], items[j]] = [items[j], items[i]]
  }
  return items
}

function makePublicChallenges(session) {
  return (session.challenges || []).map(challenge => ({
    id: challenge.id,
    ...(session.gameKey === 'hunter' ? { targetWord: challenge.word } : {}),
    definition: challenge.definition,
    prompt: challenge.prompt,
    letters: challenge.letters,
    options: (challenge.options || []).map(({ id, text }) => ({ id, text })),
    cards: (challenge.cards || []).map(({ id, challengeId, type, text }) => ({ id, challengeId, type, text })),
  }))
}

async function buildChallenges(studentId, gameKey, config) {
  const rounds = GAME_CONFIG[gameKey].expectedRounds(config)
  const now = new Date()
  // Words that are due for review come first, then never-reviewed words, then
  // everything else. Games therefore reinforce the SRS queue instead of the
  // 150 most recently saved words.
  const userWords = await Vocabulary.aggregate([
    { $match: { student: new mongoose.Types.ObjectId(studentId) } },
    {
      $addFields: {
        dueRank: {
          $cond: [
            {
              $and: [
                { $eq: ['$masteryLevel', 'learning'] },
                { $lte: ['$nextReviewDate', now] },
              ],
            },
            0,
            1,
          ],
        },
      },
    },
    { $sort: { dueRank: 1, nextReviewDate: 1, createdAt: 1 } },
    { $limit: 150 },
    { $project: { word: 1, definition: 1, exampleSentence: 1, ipa: 1 } },
  ])
  if (userWords.length < rounds) {
    throw new ErrorResponse(
      `Your library needs at least ${rounds} words to start this game.`,
      409,
    )
  }
  // `userWords` is already ordered by dueRank, so keep the first `rounds`
  // entries (due words first) and only shuffle how they are presented. Running
  // the whole pool through shuffle() here would discard the SRS priority.
  const selectedWords = shuffle(userWords.slice(0, rounds))
  const challengeIds = selectedWords.map(() => randomUUID())
  const matchingCards = gameKey === 'matching'
    ? shuffle(selectedWords.flatMap((row, index) => {
      const pairId = randomUUID()
      return [
        { id: randomUUID(), pairId, challengeId: challengeIds[index], type: 'word', text: row.word },
        { id: randomUUID(), pairId, challengeId: challengeIds[index], type: 'definition', text: row.definition || '' },
      ]
    }))
    : null

  return selectedWords.map((item, index) => {
    const id = challengeIds[index] || randomUUID()
    const distractors = shuffle(userWords.filter(row => row.word.toLowerCase() !== item.word.toLowerCase())).slice(0, 3)
    const options = shuffle([item, ...distractors]).map(row => ({ id: randomUUID(), text: row.word }))
    const rightOption = options.find(option => option.text.toLowerCase() === item.word.toLowerCase())
    const sentence = item.exampleSentence || item.definition || `Use the word ${item.word} in context.`
    const escaped = item.word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const prompt = gameKey === 'filler' ? sentence.replace(new RegExp(escaped, 'ig'), '_______') : item.definition || sentence
    const challenge = {
      id,
      word: item.word,
      definition: item.definition || '',
      prompt,
      answerId: rightOption?.id,
      options,
    }
    if (gameKey === 'scramble') challenge.letters = shuffle(item.word.toUpperCase().split(''))
    if (gameKey === 'matching') {
      const cards = matchingCards.filter(card => card.challengeId === id)
      const targetPair = cards.find(card => card.type === 'word')?.pairId
      challenge.cards = matchingCards.map(({ id: cardId, challengeId: cardChallengeId, type, text }) => ({ id: cardId, challengeId: cardChallengeId, type, text }))
      challenge.answerCardIds = cards.filter(card => card.pairId === targetPair).map(card => card.id)
    }
    return challenge
  })
}

function challengeIndex(session) {
  let index = 0
  while (session.answers.some(answer => answer.challengeIndex === index && answer.completed)) index += 1
  return index
}

function currentMatchingChallenge(session) {
  const answeredCorrectly = new Set(
    session.answers.filter(answer => answer.correct).map(answer => answer.challengeIndex),
  )
  let index = 0
  while (answeredCorrectly.has(index)) index += 1
  return index
}

export async function heartbeatGameSession(studentId, gameKey, sessionId) {
  if (!mongoose.isValidObjectId(sessionId)) throw new ErrorResponse('Game session not found', 404)
  const now = new Date()
  const session = await GameSession.findOneAndUpdate(
    { _id: sessionId, student: studentId, gameKey, status: 'active', expiresAt: { $gt: now } },
    { $set: { expiresAt: new Date(now.getTime() + SESSION_TTL_MS), lastHeartbeatAt: now } },
    { returnDocument: 'after' },
  )
  if (!session) throw new ErrorResponse('This game session has expired. Start a new game.', 410)
  return { sessionId: String(session._id), expiresAt: session.expiresAt, lastHeartbeatAt: session.lastHeartbeatAt }
}

export async function startAuthoritativeGame(studentId, gameKey, inputConfig = {}, startKey = null) {
  if (!GAME_KEYS.includes(gameKey)) throw new ErrorResponse('Unknown game', 400)
  const meta = GAME_CONFIG[gameKey]
  const config = { ...meta.defaults }
  for (const [key, allowed] of Object.entries(meta.allowed)) {
    if (inputConfig?.[key] !== undefined && allowed.includes(inputConfig[key])) config[key] = inputConfig[key]
  }
  // A repeated start (double click / retried request) must not open a second
  // session and orphan the first one.
  if (startKey) {
    const existing = await GameSession.findOne({ student: studentId, gameKey, startKey })
    if (existing) {
      return {
        sessionId: String(existing._id),
        gameKey,
        config: existing.config,
        expectedRounds: existing.expectedRounds,
        startedAt: existing.startedAt,
        expiresAt: existing.expiresAt,
        challenges: makePublicChallenges(existing),
      }
    }
  }
  const now = new Date()
  const challenges = await buildChallenges(studentId, gameKey, config)
  let session
  try {
    session = await GameSession.create({
      student: studentId,
      gameKey,
      config,
      expectedRounds: challenges.length,
      challenges,
      answers: [],
      status: 'active',
      startedAt: now,
      expiresAt: new Date(now.getTime() + SESSION_TTL_MS),
      startKey: startKey || null,
    })
  } catch (err) {
    if (err?.code !== 11000 || !startKey) throw err
    session = await GameSession.findOne({ student: studentId, gameKey, startKey })
    if (!session) throw err
  }
  // Keep the newest session active. Expiring by creation order makes two
  // concurrent starts converge on one survivor instead of both closing the
  // other's session.
  await GameSession.updateMany(
    {
      student: studentId,
      gameKey,
      status: 'active',
      _id: { $ne: session._id },
      $or: [
        { createdAt: { $lt: session.createdAt } },
        { createdAt: session.createdAt, _id: { $lt: session._id } },
      ],
    },
    { $set: { status: 'expired' } },
  )
  return {
    sessionId: String(session._id),
    gameKey,
    config,
    expectedRounds: session.expectedRounds,
    startedAt: session.startedAt,
    expiresAt: session.expiresAt,
    challenges: makePublicChallenges(session),
  }
}

export async function submitAuthoritativeAnswer(studentId, gameKey, sessionId, body = {}) {
  if (!mongoose.isValidObjectId(sessionId)) throw new ErrorResponse('Game session not found', 404)
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ErrorResponse('Invalid game answer', 400)
  const { challengeId, requestId, optionId, text, cardIds, skipped } = body
  if (typeof requestId !== 'string' || !requestId || requestId.length > 128) throw new ErrorResponse('Invalid answer requestId', 400)
  const session = await GameSession.findOne({ _id: sessionId, student: studentId, gameKey })
  if (!session) throw new ErrorResponse('Game session not found', 404)
  const duplicate = session.answers.find(answer => answer.requestId === requestId)
  if (duplicate) return { challengeId: duplicate.challengeId, correct: duplicate.correct, nextChallenge: makePublicChallenges(session)[gameKey === 'matching' ? currentMatchingChallenge(session) : challengeIndex(session)] || null }
  if (session.expiresAt <= new Date()) throw new ErrorResponse('This game session has expired. Start a new game.', 410)
  if (session.status !== 'active') throw new ErrorResponse('Game session is not active', 409)
  const index = gameKey === 'matching'
    ? session.challenges.findIndex(item => item.id === challengeId)
    : challengeIndex(session)
  const challenge = session.challenges[index]
  if (gameKey !== 'matching' && (!challenge || challenge.id !== challengeId)) throw new ErrorResponse('Answer challenges in order', 409)
  if (gameKey === 'matching' && (!challenge || session.answers.some(answer => answer.challengeIndex === index && answer.correct))) {
    throw new ErrorResponse('Matching pair is already complete or invalid', 409)
  }
  if (gameKey === 'hunter' && session.answers.some(answer => answer.challengeIndex === index && answer.completed)) {
    throw new ErrorResponse('Hunter round is already complete', 409)
  }
  let correct
  if (gameKey === 'matching') {
    if (!Array.isArray(cardIds) || cardIds.length !== 2 || cardIds.some(id => typeof id !== 'string')) throw new ErrorResponse('Invalid matching cards', 400)
    const first = challenge.cards.find(card => card.id === cardIds[0])
    const second = challenge.cards.find(card => card.id === cardIds[1])
    const expected = challenge.answerCardIds || []
    correct = Boolean(
      first && second && first.id !== second.id && expected.length === 2 &&
      expected.includes(first.id) && expected.includes(second.id)
    )
  } else if (skipped === true) {
    correct = false
  } else if (gameKey === 'scramble') {
    correct = typeof text === 'string' && text.trim().toLowerCase() === challenge.word.toLowerCase()
  } else if (gameKey === 'hunter') {
    if (typeof optionId !== 'string' || !challenge.options.some(option => option.id === optionId)) throw new ErrorResponse('Invalid answer option', 400)
    correct = optionId === challenge.answerId
  } else {
    if (typeof optionId !== 'string' || !challenge.options.some(option => option.id === optionId)) throw new ErrorResponse('Invalid answer option', 400)
    correct = optionId === challenge.answerId
  }
  const answerRow = {
    requestId,
    challengeId,
    challengeIndex: index,
    correct,
    skipped: skipped === true || undefined,
    // Scramble keeps the same round open after a wrong attempt so the learner
    // can fix a typo; filler advances on any answer, hunter when the round is
    // resolved (correct or missed).
    completed: gameKey === 'filler' || (gameKey === 'scramble' && (correct || skipped === true)) || (gameKey === 'hunter' && (correct || skipped)) || undefined,
    answeredAt: new Date(),
  }
  const updated = await GameSession.findOneAndUpdate(
    {
      _id: session._id, student: studentId, gameKey, status: 'active',
      [`answers.${session.answers.length}`]: { $exists: false },
    },
    { $push: { answers: answerRow } },
    { returnDocument: 'after' },
  )
  if (!updated) {
    const latest = await GameSession.findOne({ _id: session._id, student: studentId, gameKey })
    const replay = latest?.answers.find(answer => answer.requestId === requestId)
    if (replay) return { challengeId, correct: replay.correct, nextChallenge: makePublicChallenges(latest)[gameKey === 'matching' ? currentMatchingChallenge(latest) : challengeIndex(latest)] || null }
    throw new ErrorResponse('Answer state changed; retry this answer', 409)
  }
  return { challengeId, correct, nextChallenge: makePublicChallenges(updated)[gameKey === 'matching' ? currentMatchingChallenge(updated) : challengeIndex(updated)] || null }
}

export async function finishAuthoritativeGame(studentId, gameKey, sessionId) {
  if (!mongoose.isValidObjectId(sessionId)) throw new ErrorResponse('Game session not found', 404)
  const session = await GameSession.findOne({ _id: sessionId, student: studentId, gameKey })
  if (!session) throw new ErrorResponse('Game session not found', 404)
  if (session.status === 'finishing' || session.status === 'finished') {
    return finishGameSession(studentId, gameKey, sessionId, {})
  }
  if (session.status === 'finished' && !await GameResult.exists({ session: session._id }) && session.finishPayload) {
    return finishGameSession(studentId, gameKey, sessionId, {})
  }
  if (session.expiresAt <= new Date()) {
    throw new ErrorResponse('This game session has expired. Start a new game.', 410)
  }
  if (session.status !== 'active') throw new ErrorResponse('Game session is not active', 409)
  const correctAnswers = session.answers.filter(answer => answer.correct)
  const total = session.challenges.length
  if (session.gameKey === 'matching') {
    if (currentMatchingChallenge(session) < total) throw new ErrorResponse('Match every pair before finishing', 409)
  } else if (session.gameKey === 'hunter') {
    // Vocab Hunter ends when the player runs out of lives or the 90 second
    // round expires, so a partial run is a valid result. Require three missed
    // bubbles (the starting lives) or the full round: wrong taps alone must not
    // unlock an instant finish.
    const elapsedMs = Date.now() - new Date(session.startedAt).getTime()
    const missed = session.answers.filter(answer => answer.skipped).length
    if (challengeIndex(session) < total && missed < 3 && elapsedMs < HUNTER_ROUND_MS) {
      throw new ErrorResponse('Play a few rounds before finishing', 409)
    }
  } else if (challengeIndex(session) < total) {
    throw new ErrorResponse('Complete every challenge before finishing', 409)
  }
  if (session.gameKey === 'hunter') {
    // Rounds that were never reached are recorded as skipped so the stored
    // session and its score agree.
    const answeredIds = new Set(session.answers.map(answer => answer.challengeId))
    const now = new Date()
    const skipped = session.challenges
      .filter(challenge => !answeredIds.has(challenge.id))
      .map(challenge => ({
        challengeId: challenge.id,
        correct: false,
        skipped: true,
        completed: true,
        answeredAt: now,
      }))
    if (skipped.length) {
      await GameSession.updateOne(
        { _id: session._id, student: studentId, gameKey, status: 'active' },
        { $push: { answers: { $each: skipped } } },
      )
      session.answers.push(...skipped)
    }
  }
  const correct = correctAnswers.length
  const score = gameKey === 'matching' || gameKey === 'hunter' ? correct * 100 : correct
  let bestStreak = 0
  let streak = 0
  for (let index = 0; index < total; index += 1) {
    const answer = correctAnswers.find(row => row.challengeIndex === index)
    streak = answer ? streak + 1 : 0
    bestStreak = Math.max(bestStreak, streak)
  }
  const attempts = session.answers.length
  const meta = gameKey === 'matching'
    ? { attempts: Math.max(total, attempts) }
    : gameKey === 'hunter'
      ? { roundsCleared: correct, livesRemaining: Math.max(0, 3 - (total - correct)), speedLevel: session.config.speedLevel || 'medium' }
      : { bestStreak }
  const durationMs = Math.min(SESSION_TTL_MS, Math.max(0, Date.now() - new Date(session.startedAt).getTime()))
  const finishPayload = { score, correct, total, durationMs, meta }
  await GameSession.updateOne(
    { _id: session._id, student: studentId, gameKey, status: 'active' },
    { $set: { finishPayload } },
  )
  return finishGameSession(studentId, gameKey, sessionId, {})
}

import ErrorResponse from '../utils/ErrorResponse.js'
import { XP_RULES } from '../constants/gamification.js'
import { wordCells } from './crossword.service.js'

export const QUEST_HINT_LIMIT = 3
export const questXpReward = (revealed = []) =>
  Math.max(5, XP_RULES.dailyQuest - (revealed?.length || 0) * 2)

export function publicQuest(quest, overrideCells = null) {
  const cells = overrideCells !== null
    ? overrideCells
    : (quest.cells instanceof Map ? Object.fromEntries(quest.cells) : quest.cells)
  return {
    id: String(quest._id),
    day: quest.day,
    timezone: 'Asia/Ho_Chi_Minh',
    version: quest.version,
    rows: quest.rows,
    cols: quest.cols,
    revision: quest.revision,
    cells: cells || {},
    solved: quest.solved,
    assisted: quest.assisted,
    revealed: quest.revealed || [],
    hintsLeft: Math.max(0, QUEST_HINT_LIMIT - (quest.revealed || []).length),
    startedAt: quest.startedAt,
    completedAt: quest.completedAt,
    reward: quest.reward,
    // Hints cost XP, so the advertised reward must match what completion pays.
    xpReward: questXpReward(quest.revealed),
    source: quest.source || 'fallback',
    sourceReason: quest.sourceReason || '',
    words: quest.words.map(
      ({ id, number, row, col, direction, answer, clue, clueVi, example, source }) => ({
        id,
        number,
        row,
        col,
        direction,
        length: answer.length,
        clue,
        clueVi,
        example,
        source,
        ...(quest.completedAt ? { answer } : {}),
      }),
    ),
  }
}

// All changes to a play session are persisted together with optimistic locking.
export function applyPlay(quest, body, now = new Date()) {
  if (!['save', 'check', 'hint'].includes(body.action) || !Number.isInteger(body.revision))
    throw new ErrorResponse('Invalid quest action', 400)
  if (!body.cells || typeof body.cells !== 'object' || Array.isArray(body.cells))
    throw new ErrorResponse('Invalid cells', 400)
  const allowed = new Set(quest.words.flatMap(wordCells))
  const cells = {}
  for (const [key, value] of Object.entries(body.cells)) {
    if (!allowed.has(key) || typeof value !== 'string' || !/^[A-Z]?$/.test(value))
      throw new ErrorResponse('Invalid cell value', 400)
    if (value) cells[key] = value
  }
  const solved = [...quest.solved],
    assisted = [...quest.assisted],
    revealed = [...(quest.revealed || [])]
  // Letters supplied by a completed word or by a hint belong to the board for
  // good. Re-applying them on every save means a stray keystroke can never
  // erase them, and the client locks the same cells so the player cannot try.
  for (const word of quest.words) {
    const keys = wordCells(word)
    const done = solved.includes(word.id)
    keys.forEach((key, i) => {
      if (done || revealed.includes(key)) cells[key] = word.answer[i]
    })
  }
  let correct = null
  if (body.action !== 'save') {
    const word = quest.words.find((w) => w.id === body.wordId)
    if (!word) throw new ErrorResponse('Unknown clue', 400)
    const keys = wordCells(word)
    if (body.action === 'hint') {
      // A hint reveals exactly ONE letter; it never auto-solves the clue.
      if (revealed.length >= QUEST_HINT_LIMIT)
        throw new ErrorResponse('Hint limit reached for this quest', 429)
      if (!solved.includes(word.id)) {
        const revealIndex = keys.findIndex((key, i) => cells[key] !== word.answer[i])
        if (revealIndex >= 0) {
          cells[keys[revealIndex]] = word.answer[revealIndex]
          if (!revealed.includes(keys[revealIndex])) revealed.push(keys[revealIndex])
        }
        if (!assisted.includes(word.id)) assisted.push(word.id)
      }
    } else {
      correct = keys.map((key) => cells[key] || '').join('') === word.answer
      if (correct && !solved.includes(word.id)) solved.push(word.id)
    }
  }
  const completed = solved.length === quest.words.length
  return {
    correct,
    update: {
      cells,
      solved,
      assisted,
      revealed,
      startedAt: quest.startedAt || now,
      checks: quest.checks + (body.action === 'check' ? 1 : 0),
      ...(completed ? { completedAt: now, reward: 1 } : {}),
    },
  }
}
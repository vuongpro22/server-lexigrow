import { createHash } from 'node:crypto'

export const STARTER_WORDS = [
  [
    'garden',
    'A place where flowers and vegetables grow.',
    'Khu vườn',
    'We grow flowers in the garden.',
  ],
  ['learn', 'To gain knowledge or a new skill.', 'Học', 'I learn something new every day.'],
  ['water', 'The clear liquid that plants need.', 'Nước', 'Plants need water to grow.'],
  ['read', 'To look at words and understand them.', 'Đọc', 'I read a book before bed.'],
  ['green', 'The colour of fresh grass.', 'Màu xanh lá', 'The leaves are green.'],
  ['plant', 'A living thing with roots and leaves.', 'Cây', 'This plant needs sunlight.'],
  ['travel', 'To go from one place to another.', 'Đi du lịch', 'We travel by train.'],
  ['share', 'To let someone use or enjoy something with you.', 'Chia sẻ', 'We share our ideas.'],
  ['create', 'To make something new.', 'Tạo ra', 'Artists create beautiful pictures.'],
  ['dream', 'Something you hope to achieve.', 'Ước mơ', 'My dream is to become a teacher.'],
  ['friend', 'A person you like and trust.', 'Người bạn', 'My friend helps me study.'],
  [
    'nature',
    'The world of plants, animals and landscapes.',
    'Thiên nhiên',
    'We should protect nature.',
  ],
].map(([word, definition, translation, exampleSentence]) => ({
  word,
  definition,
  translation,
  exampleSentence,
  source: 'starter',
}))

export const QUEST_TIMEZONE = 'Asia/Ho_Chi_Minh'

export function questDay(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: QUEST_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now)
}

/**
 * Days a quest may still be played. Between midnight and 02:00 the previous
 * day's board stays open so a quest started at 23:59 is not lost mid-word.
 */
export function questDaysInPlay(now = new Date()) {
  const today = questDay(now)
  const hour = Number(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: QUEST_TIMEZONE,
      hour: '2-digit',
      hour12: false,
    }).format(now),
  )
  if (hour >= 2) return [today]
  const previous = new Date(`${today}T00:00:00Z`)
  previous.setUTCDate(previous.getUTCDate() - 1)
  return [today, previous.toISOString().slice(0, 10)]
}

/**
 * Escape regex metacharacters in an answer before building a mask pattern.
 * @param {string} value
 * @returns {string}
 */
function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Common inflected forms of a clue answer, so "evaluates" and "gardens" are
 * masked as well as "evaluate" and "garden".
 */
function inflectedForms(answer) {
  const base = String(answer).toLowerCase()
  const forms = new Set([base, `${base}s`, `${base}ed`, `${base}ing`])
  if (base.endsWith('e')) {
    forms.add(`${base}d`)
    forms.add(`${base.slice(0, -1)}ing`)
  }
  // "watch"→"watches", but not "plan"→"planes".
  if (/(?:s|x|z|ch|sh|o)$/.test(base)) forms.add(`${base}es`)
  // Consonant-vowel-consonant doubling: run→running, stop→stopped.
  if (/[^aeiou][aeiou][bdgklmnprt]$/.test(base)) {
    const stem = base.slice(0, -1)
    const last = base.slice(-1)
    forms.add(`${stem}${last}${last}ed`)
    forms.add(`${stem}${last}${last}ing`)
  }
  if (base.endsWith('y')) {
    const stem = base.slice(0, -1)
    forms.add(`${stem}ies`)
    forms.add(`${stem}ied`)
    forms.add(`${stem}ier`)
    forms.add(`${stem}iest`)
    forms.add(`${stem}ily`)
  }
  return [...forms].sort((a, b) => b.length - a.length)
}

export function maskAnswer(text, answer) {
  const pattern = new RegExp(
    `\\b(?:${inflectedForms(answer).map(escapeRegExp).join('|')})\\b`,
    'gi',
  )
  return String(text || '').slice(0, 600).replace(pattern, '_____')
}

export function prepareWords(words) {
  const seen = new Set()
  return words.flatMap((item) => {
    const answer = String(item.word || '')
      .trim()
      .toUpperCase()
    if (!/^[A-Z]{3,10}$/.test(answer) || seen.has(answer)) return []
    // LG-40: word-boundary match so "CAT" is not masked inside "CONCATENATE".
    // `\b` still anchors correctly when the answer is a multi-word phrase.
    // Inflected forms ("evaluates", "gardens") are masked too.
    const mask = (text) => maskAnswer(text, answer)
    const clue = mask(item.definition)
    if (!clue.trim() || clue === '_____') return []
    seen.add(answer)
    return [
      {
        answer,
        clue,
        clueVi: mask(item.translation),
        example: mask(item.exampleSentence),
        source: item.source || 'personal',
      },
    ]
  })
}

// A bounded greedy search: only perpendicular crossings, no touching words.
export function generateCrossword(candidates, seed, count = 6) {
  const words = prepareWords(candidates).slice(0, 100)
  const rank = (word) => createHash('sha256').update(`${seed}:${word.answer}`).digest('hex')
  const ordered = words
    .map((word, priority) => ({ ...word, priority, rank: rank(word) }))
    .sort(
      (a, b) =>
        Math.floor(a.priority / 12) - Math.floor(b.priority / 12) || a.rank.localeCompare(b.rank),
    )
  let best = []
  for (const first of ordered.slice(0, 16)) {
    const grid = new Map()
    const placed = []
    const key = (r, c) => `${r},${c}`
    const add = (word, row, col, direction) => {
      placed.push({ ...word, row, col, direction })
      Array.from(word.answer).forEach((letter, i) => {
        const k = key(row + (direction === 'down' ? i : 0), col + (direction === 'across' ? i : 0))
        const old = grid.get(k)
        grid.set(k, { letter, directions: [...(old?.directions || []), direction] })
      })
    }
    const fits = (word, row, col, direction) => {
      const dr = direction === 'down' ? 1 : 0,
        dc = 1 - dr
      if (
        grid.has(key(row - dr, col - dc)) ||
        grid.has(key(row + dr * word.answer.length, col + dc * word.answer.length))
      )
        return false
      let crossings = 0
      for (let i = 0; i < word.answer.length; i++) {
        const r = row + dr * i,
          c = col + dc * i,
          cell = grid.get(key(r, c))
        if (cell) {
          if (cell.letter !== word.answer[i] || cell.directions.includes(direction)) return false
          crossings++
        } else if (grid.has(key(r + dc, c + dr)) || grid.has(key(r - dc, c - dr))) return false
      }
      const rows = [...placed.map((w) => w.row), row],
        cols = [...placed.map((w) => w.col), col]
      const endsR = [
        ...placed.map((w) => w.row + (w.direction === 'down' ? w.answer.length - 1 : 0)),
        row + dr * (word.answer.length - 1),
      ]
      const endsC = [
        ...placed.map((w) => w.col + (w.direction === 'across' ? w.answer.length - 1 : 0)),
        col + dc * (word.answer.length - 1),
      ]
      return (
        crossings > 0 &&
        Math.max(...endsR) - Math.min(...rows) < 11 &&
        Math.max(...endsC) - Math.min(...cols) < 11
      )
    }
    add(first, 0, 0, 'across')
    for (let pass = 0; pass < 2 && placed.length < count; pass++) {
      for (const word of ordered) {
        if (placed.length >= count) break
        if (placed.some((w) => w.answer === word.answer)) continue
        let position
        for (const [k, cell] of grid) {
          const [r, c] = k.split(',').map(Number)
          for (let i = 0; i < word.answer.length && !position; i++) {
            if (word.answer[i] !== cell.letter) continue
            for (const direction of ['across', 'down']) {
              const row = r - (direction === 'down' ? i : 0),
                col = c - (direction === 'across' ? i : 0)
              if (fits(word, row, col, direction)) {
                position = { row, col, direction }
                break
              }
            }
          }
          if (position) break
        }
        if (position) add(word, position.row, position.col, position.direction)
      }
    }
    if (placed.length > best.length) best = placed
    if (best.length >= count) break
  }
  if (!best.length) return { words: [], rows: 0, cols: 0 }
  const minR = Math.min(...best.map((w) => w.row)),
    minC = Math.min(...best.map((w) => w.col))
  const starts = new Map()
  const result = best
    .map((w) => ({ ...w, row: w.row - minR, col: w.col - minC }))
    .sort((a, b) => a.row - b.row || a.col - b.col)
    .map((w, i) => {
      const k = `${w.row},${w.col}`
      if (!starts.has(k)) starts.set(k, starts.size + 1)
      const word = { ...w }
      delete word.priority
      delete word.rank
      return { ...word, id: String(i), number: starts.get(k) }
    })
  return {
    words: result,
    rows: Math.max(...result.map((w) => w.row + (w.direction === 'down' ? w.answer.length : 1))),
    cols: Math.max(...result.map((w) => w.col + (w.direction === 'across' ? w.answer.length : 1))),
  }
}

export function wordCells(word) {
  return Array.from(
    word.answer,
    (_, i) =>
      `${word.row + (word.direction === 'down' ? i : 0)},${word.col + (word.direction === 'across' ? i : 0)}`,
  )
}

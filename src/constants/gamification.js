export const GAME_KEYS = ['hunter', 'filler', 'scramble', 'matching']

export const GAME_LABELS = {
  hunter: 'Vocab Hunter',
  filler: 'Context Filler',
  scramble: 'Word Scramble',
  matching: 'Word Matching',
}

export const GAME_CONFIG = {
  hunter: {
    defaults: { speedLevel: 'medium' },
    allowed: { speedLevel: ['easy', 'medium', 'hard'] },
    expectedRounds: () => 15,
  },
  filler: {
    defaults: { roundCount: 5 },
    allowed: { roundCount: [5, 8, 12] },
    expectedRounds: (config) => config.roundCount,
  },
  scramble: {
    defaults: { roundCount: 5 },
    allowed: { roundCount: [5, 10, 15] },
    expectedRounds: (config) => config.roundCount,
  },
  matching: {
    defaults: { pairCount: 4 },
    allowed: { pairCount: [4, 6, 8] },
    expectedRounds: (config) => config.pairCount,
  },
}

export const XP_RULES = {
  dailyQuest: 20,
  gameBase: 5,
  gameAccuracyMax: 20,
  gameDailyCap: 60,
  // Vocabulary XP is earned by reviewing and using words, never by saving them.
  vocabFirstReview: 2,
  vocabDailyReview: 1,
  vocabMastered: 10,
  vocabUsage: 2,
  vocabDailyCap: 30,
  // Essay XP is earned only after a successful AI analysis of real work.
  essayBase: 15,
  essayTargetWord: 1,
  essayTargetWordMax: 10,
  essayLengthBonus: 5,
  essayLengthThreshold: 120,
  essayMinWords: 50,
  essayRevisionBonus: 5,
  essayDailyCap: 50,
  // Optional small reward for correct, unhinted practice answers.
  practiceCorrect: 1,
  practiceDailyCap: 20,
  levelThresholds: [0, 150, 400, 750, 1200, 1800, 2600, 3600, 5000, 7000],
}

export const DEFAULT_LEVEL_RULES = [
  { level: 1, name: 'Seed', minXp: 0, rewards: [{ type: 'badge', key: 'level_1' }] },
  {
    level: 2,
    name: 'Sprout',
    minXp: 150,
    rewards: [
      { type: 'badge', key: 'level_2' },
      { type: 'firefly', key: 'level_2_firefly', amount: 1 },
    ],
  },
  { level: 3, name: 'Leafy', minXp: 400, rewards: [{ type: 'badge', key: 'level_3' }] },
  { level: 4, name: 'Bud', minXp: 750, rewards: [{ type: 'badge', key: 'level_4' }] },
  {
    level: 5,
    name: 'Bloom',
    minXp: 1200,
    rewards: [
      { type: 'badge', key: 'level_5' },
      { type: 'firefly', key: 'level_5_firefly', amount: 1 },
    ],
  },
  { level: 6, name: 'Flourish', minXp: 1800, rewards: [{ type: 'badge', key: 'level_6' }] },
  { level: 7, name: 'Garden', minXp: 2600, rewards: [{ type: 'badge', key: 'level_7' }] },
  {
    level: 8,
    name: 'Forest',
    minXp: 3600,
    rewards: [
      { type: 'badge', key: 'level_8' },
      { type: 'firefly', key: 'level_8_firefly', amount: 1 },
    ],
  },
  { level: 9, name: 'Grove', minXp: 5000, rewards: [{ type: 'badge', key: 'level_9' }] },
  {
    level: 10,
    name: 'Legend',
    minXp: 7000,
    rewards: [
      { type: 'badge', key: 'level_10' },
      { type: 'firefly', key: 'level_10_firefly', amount: 2 },
    ],
  },
]

export const GAME_RESULT_FIELDS = ['score', 'correct', 'total', 'durationMs']

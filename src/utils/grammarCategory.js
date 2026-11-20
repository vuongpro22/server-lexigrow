const DEFAULT_GRAMMAR_CATEGORY = 'Sentence Structure & Style'

const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// Unicode-aware word boundaries: \b only knows ASCII letters, so it cannot
// anchor Vietnamese keywords that start or end with an accented letter.
const keywordMatcher = (keyword) => new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegex(keyword.normalize('NFC'))}(?![\\p{L}\\p{N}])`, 'iu')

/**
 * Grammar error categories used by the classroom heatmap.
 *
 * Bare function words such as "in", "on", "at", "a", "an" and "the" are
 * intentionally absent: matching them inside ordinary feedback text assigned
 * almost every suggestion to Preposition/Articles. Only explicit grammar
 * labels are used, and every keyword is matched on word boundaries so
 * "presentation" no longer matches "present".
 */
export const GRAMMAR_CATEGORIES = [
  {
    key: 'Verb Tenses/Forms',
    code: 'verb_tense',
    keywords: ['tense', 'tenses', 'past', 'present', 'future', 'conjugation', 'verb form', 'infinitive', 'gerund', 'participle',
      'thì động từ', 'thì quá khứ', 'thì hiện tại', 'thì tương lai', 'chia động từ', 'dạng động từ', 'quá khứ đơn', 'hiện tại hoàn thành',
      'quá khứ phân từ', 'động từ nguyên mẫu', 'danh động từ'],
  },
  {
    key: 'Subject-Verb Agreement',
    code: 'subject_verb_agreement',
    keywords: ['subject-verb', 'agreement', 'singular', 'plural', 'verbs agreement',
      'hoà hợp chủ ngữ', 'hòa hợp chủ ngữ', 'hoà hợp giữa chủ ngữ', 'hòa hợp giữa chủ ngữ', 'chủ ngữ số ít', 'chủ ngữ số nhiều', 'số ít', 'số nhiều'],
  },
  {
    key: 'Preposition Usage',
    code: 'preposition',
    keywords: ['preposition', 'prepositions', 'prepositional phrase', 'giới từ'],
  },
  {
    key: 'Articles (A/An/The)',
    code: 'article',
    keywords: ['article', 'articles', 'definite article', 'indefinite article', 'mạo từ'],
  },
  {
    key: 'Punctuation',
    code: 'punctuation',
    keywords: ['comma', 'commas', 'punctuation', 'semi-colon', 'colon', 'apostrophe', 'period', 'question mark',
      'dấu câu', 'dấu phẩy', 'dấu chấm', 'dấu chấm phẩy', 'dấu hai chấm', 'dấu nháy', 'dấu chấm hỏi'],
  },
  {
    key: 'Spelling',
    code: 'spelling',
    keywords: ['spelling', 'misspell', 'misspelling', 'typo', 'spell check', 'chính tả', 'lỗi đánh máy', 'viết sai từ'],
  },
  {
    key: 'Passive Voice Overuse',
    code: 'passive_voice',
    keywords: ['passive voice', 'passive form', 'câu bị động', 'thể bị động'],
  },
  {
    key: 'Vocabulary Selection',
    code: 'vocabulary',
    keywords: ['vocabulary', 'word choice', 'synonym', 'repetitive word', 'redundant', 'word selection',
      'từ vựng', 'chọn từ', 'lặp từ', 'lặp lại từ', 'từ đồng nghĩa', 'cách dùng từ'],
  },
  {
    key: 'Coherence & Transitions',
    code: 'coherence',
    keywords: ['coherence', 'transition', 'transitions', 'connective', 'connectives', 'cohesive', 'linking word',
      'mạch lạc', 'liên kết', 'từ nối', 'chuyển ý', 'từ chuyển tiếp'],
  },
].map(category => ({
  ...category,
  matchers: category.keywords.map(keywordMatcher),
}))

/**
 * Classify one improvement suggestion into the grammar heatmap category.
 * Matching is case-insensitive and anchored on word boundaries.
 */
export function classifyGrammarErrorText(text) {
  const value = String(text || '').normalize('NFC')
  if (!value) return DEFAULT_GRAMMAR_CATEGORY

  for (const category of GRAMMAR_CATEGORIES) {
    if (category.matchers.some(matcher => matcher.test(value))) {
      return category.key
    }
  }

  return DEFAULT_GRAMMAR_CATEGORY
}

// Category codes the grading model returns in suggestion.errorCategory.
export const SENTENCE_STRUCTURE_CODE = 'sentence_structure'
export const ERROR_CATEGORY_CODES = [...GRAMMAR_CATEGORIES.map(category => category.code), SENTENCE_STRUCTURE_CODE]

const CATEGORY_BY_CODE = new Map([
  ...GRAMMAR_CATEGORIES.map(category => [category.code, category.key]),
  [SENTENCE_STRUCTURE_CODE, DEFAULT_GRAMMAR_CATEGORY],
])

/** Returns a known category code, or '' for anything else. */
export function normalizeErrorCategory(value) {
  const code = String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_')
  return CATEGORY_BY_CODE.has(code) ? code : ''
}

/**
 * Heatmap category of one suggestion. The model's own errorCategory wins;
 * keyword matching on the feedback text covers analyses graded before it.
 */
export function classifyGrammarSuggestion(suggestion) {
  const code = normalizeErrorCategory(suggestion?.errorCategory)
  if (code) return CATEGORY_BY_CODE.get(code)
  return classifyGrammarErrorText(suggestion?.text)
}

export { DEFAULT_GRAMMAR_CATEGORY }

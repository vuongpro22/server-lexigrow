const DEFAULT_GRAMMAR_CATEGORY = 'Sentence Structure & Style'

const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const keywordMatcher = (keyword) => new RegExp(`\\b${escapeRegex(keyword)}\\b`, 'i')

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
    keywords: ['tense', 'tenses', 'past', 'present', 'future', 'conjugation', 'verb form', 'infinitive', 'gerund', 'participle'],
  },
  {
    key: 'Subject-Verb Agreement',
    keywords: ['subject-verb', 'agreement', 'singular', 'plural', 'verbs agreement'],
  },
  {
    key: 'Preposition Usage',
    keywords: ['preposition', 'prepositions', 'prepositional phrase'],
  },
  {
    key: 'Articles (A/An/The)',
    keywords: ['article', 'articles', 'definite article', 'indefinite article'],
  },
  {
    key: 'Punctuation',
    keywords: ['comma', 'commas', 'punctuation', 'semi-colon', 'colon', 'apostrophe', 'period', 'question mark'],
  },
  {
    key: 'Spelling',
    keywords: ['spelling', 'misspell', 'misspelling', 'typo', 'spell check'],
  },
  {
    key: 'Passive Voice Overuse',
    keywords: ['passive voice', 'passive form'],
  },
  {
    key: 'Vocabulary Selection',
    keywords: ['vocabulary', 'word choice', 'synonym', 'repetitive word', 'redundant', 'word selection'],
  },
  {
    key: 'Coherence & Transitions',
    keywords: ['coherence', 'transition', 'transitions', 'connective', 'connectives', 'cohesive', 'linking word'],
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
  const value = String(text || '')
  if (!value) return DEFAULT_GRAMMAR_CATEGORY

  for (const category of GRAMMAR_CATEGORIES) {
    if (category.matchers.some(matcher => matcher.test(value))) {
      return category.key
    }
  }

  return DEFAULT_GRAMMAR_CATEGORY
}

export { DEFAULT_GRAMMAR_CATEGORY }

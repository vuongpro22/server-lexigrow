import { describe, expect, it } from 'vitest'
import {
  classifyGrammarErrorText,
  classifyGrammarSuggestion,
  normalizeErrorCategory,
  ERROR_CATEGORY_CODES,
  DEFAULT_GRAMMAR_CATEGORY,
} from '../src/utils/grammarCategory.js'

describe('grammar heatmap classification', () => {
  it('does not treat bare prepositions as Preposition Usage', () => {
    expect(classifyGrammarErrorText('Use in this sentence')).toBe(DEFAULT_GRAMMAR_CATEGORY)
    expect(classifyGrammarErrorText('Put the book on the table')).toBe(DEFAULT_GRAMMAR_CATEGORY)
    expect(classifyGrammarErrorText('Talk with your partner')).toBe(DEFAULT_GRAMMAR_CATEGORY)
  })

  it('does not treat bare articles as Articles (A/An/The)', () => {
    expect(classifyGrammarErrorText('Add the before the noun')).toBe(DEFAULT_GRAMMAR_CATEGORY)
    expect(classifyGrammarErrorText('Use a before a consonant')).toBe(DEFAULT_GRAMMAR_CATEGORY)
    expect(classifyGrammarErrorText('This is an example')).toBe(DEFAULT_GRAMMAR_CATEGORY)
  })

  it('matches explicit grammar labels on word boundaries', () => {
    expect(classifyGrammarErrorText('Check the preposition after the verb')).toBe('Preposition Usage')
    expect(classifyGrammarErrorText('Add the definite article before the noun')).toBe('Articles (A/An/The)')
    expect(classifyGrammarErrorText('The past tense is inconsistent')).toBe('Verb Tenses/Forms')
    expect(classifyGrammarErrorText('Use a comma after the clause')).toBe('Punctuation')
    expect(classifyGrammarErrorText('Fix the spelling of this word')).toBe('Spelling')
  })

  it('does not match a keyword inside a longer word', () => {
    expect(classifyGrammarErrorText('Improve your presentation skills')).toBe(DEFAULT_GRAMMAR_CATEGORY)
    expect(classifyGrammarErrorText('Check the tense marker')).toBe('Verb Tenses/Forms')
    expect(classifyGrammarErrorText('The paste is dry')).toBe(DEFAULT_GRAMMAR_CATEGORY)
  })
})

describe('Vietnamese feedback and model-provided categories', () => {
  it.each([
    ['Sai thì động từ: nên dùng quá khứ đơn "went".', 'Verb Tenses/Forms'],
    ['Thiếu mạo từ "the" trước danh từ xác định.', 'Articles (A/An/The)'],
    ['Giới từ chưa đúng: dùng "interested in".', 'Preposition Usage'],
    ['Chủ ngữ số ít nên động từ phải chia "is".', 'Subject-Verb Agreement'],
    ['Thiếu dấu phẩy sau từ nối "However".', 'Punctuation'],
    ['Sai chính tả: "recieve" → "receive".', 'Spelling'],
    ['Nên dùng từ nối để chuyển ý mạch lạc hơn.', 'Coherence & Transitions'],
  ])('classifies "%s"', (text, category) => {
    expect(classifyGrammarErrorText(text)).toBe(category)
  })

  it('does not read the conjunction "thì" as a tense error', () => {
    expect(classifyGrammarErrorText('Câu này thì hơi dài, nên tách thành hai câu.')).toBe(DEFAULT_GRAMMAR_CATEGORY)
  })

  it('matches Vietnamese keywords written with decomposed Unicode', () => {
    expect(classifyGrammarErrorText('Thiếu mạo từ'.normalize('NFD'))).toBe('Articles (A/An/The)')
  })

  it('prefers the model errorCategory and falls back to the text for unknown codes', () => {
    expect(classifyGrammarSuggestion({ errorCategory: 'article', text: 'Sai chính tả' })).toBe('Articles (A/An/The)')
    expect(classifyGrammarSuggestion({ errorCategory: 'Subject-Verb Agreement', text: '' })).toBe('Subject-Verb Agreement')
    expect(classifyGrammarSuggestion({ errorCategory: 'made_up', text: 'Sai chính tả' })).toBe('Spelling')
    expect(classifyGrammarSuggestion({ errorCategory: 'sentence_structure', text: 'Sai chính tả' })).toBe(DEFAULT_GRAMMAR_CATEGORY)
  })

  it('normalizes category codes', () => {
    expect(normalizeErrorCategory(' Verb-Tense ')).toBe('verb_tense')
    expect(normalizeErrorCategory('anything')).toBe('')
    expect(ERROR_CATEGORY_CODES).toContain('sentence_structure')
  })
})

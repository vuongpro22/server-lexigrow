import { describe, expect, it } from 'vitest'
import {
  classifyGrammarErrorText,
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

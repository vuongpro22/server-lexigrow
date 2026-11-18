import { describe, expect, it } from 'vitest'
import { filterByFoldedText, foldDiacritics } from '../src/utils/foldDiacritics.js'

const teachers = [
  { _id: '1', name: 'Phạm Minh Quân', email: 'quanpm@fpt.edu.vn' },
  { _id: '2', name: 'Cô Tuyết Minh', email: 'teacher@lexigrow.com' },
  { _id: '3', name: 'Tô Đình Văn', email: 'vantd@gmail.com' },
]

describe('foldDiacritics', () => {
  it('folds Vietnamese tone marks and đ', () => {
    expect(foldDiacritics('Phạm Minh Quân')).toBe('pham minh quan')
    expect(foldDiacritics('Tô Đình Văn')).toBe('to dinh van')
  })

  it('leaves an already-folded string unchanged', () => {
    expect(foldDiacritics('pham')).toBe('pham')
  })
})

describe('filterByFoldedText', () => {
  it('matches a prefix typed without tone marks', () => {
    expect(filterByFoldedText(teachers, 'pha', ['name', 'email']).map((t) => t.name)).toEqual(['Phạm Minh Quân'])
    expect(filterByFoldedText(teachers, 'ph', ['name', 'email']).map((t) => t.name)).toEqual(['Phạm Minh Quân'])
  })

  it('matches the accented spelling as well', () => {
    expect(filterByFoldedText(teachers, 'Phạm', ['name', 'email']).map((t) => t.name)).toEqual(['Phạm Minh Quân'])
  })

  it('matches đ without its mark', () => {
    expect(filterByFoldedText(teachers, 'dinh', ['name', 'email']).map((t) => t.name)).toEqual(['Tô Đình Văn'])
  })

  it('matches on email and is case-insensitive', () => {
    expect(filterByFoldedText(teachers, 'QUANPM', ['name', 'email']).map((t) => t.name)).toEqual(['Phạm Minh Quân'])
  })

  it('returns every document for an empty query', () => {
    expect(filterByFoldedText(teachers, '   ', ['name'])).toHaveLength(3)
  })

  it('returns nothing when no field contains the query', () => {
    expect(filterByFoldedText(teachers, 'zzz', ['name', 'email'])).toEqual([])
  })
})

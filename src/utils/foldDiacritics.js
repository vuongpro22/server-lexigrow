/**
 * Fold Vietnamese (and other Latin) diacritics so a query typed without tone
 * marks still matches accented data: "pha" and "pham" both find "Phạm".
 * NFD splits a letter from its marks, which are then dropped; đ/Đ is folded
 * by hand because NFD leaves it intact.
 */
export const foldDiacritics = (value) => String(value ?? '')
  .normalize('NFD')
  .replace(/[̀-ͯ]/g, '')
  .replace(/đ/g, 'd')
  .replace(/Đ/g, 'D')
  .toLowerCase()

/**
 * Keep the documents whose `fields` contain `query`, ignoring accents and case.
 * Mongo has no accent-insensitive comparison for this script, so the match
 * happens here; the collections behind the admin pickers are small.
 */
export function filterByFoldedText(docs, query, fields) {
  const needle = foldDiacritics(String(query ?? '').trim())
  if (!needle) return docs
  return docs.filter((doc) => fields.some((field) => foldDiacritics(doc[field]).includes(needle)))
}

export default foldDiacritics

// Combining marks (U+0300–U+036F), written as literal characters so the same
// pattern source works in JS and in MongoDB's PCRE, which has no \u escapes.
const COMBINING_MARKS = `[${String.fromCharCode(0x300)}-${String.fromCharCode(0x36f)}]*`

// Every Latin letter that folds to a given ASCII letter, both cases:
// a → aAàÀáÁ…ăĂâÂ…, d → dDđĐ. Built once from the Latin blocks.
const FOLD_VARIANTS = (() => {
  const map = new Map()
  const add = (ch) => {
    const base = foldDiacritics(ch)
    if (!/^[a-z]$/.test(base)) return
    if (!map.has(base)) map.set(base, new Set([base, base.toUpperCase()]))
    map.get(base).add(ch)
  }
  for (let code = 0xc0; code <= 0x24f; code += 1) add(String.fromCharCode(code))
  for (let code = 0x1e00; code <= 0x1eff; code += 1) add(String.fromCharCode(code))
  return new Map([...map].map(([base, chars]) => [base, `[${[...chars].join('')}]`]))
})()

const escapeRegex = (ch) => ch.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&')

/**
 * A regex that matches the same documents as filterByFoldedText, so the
 * accent-insensitive search can run inside MongoDB instead of loading the
 * whole collection. Returns null for an empty query (no filter).
 */
export function foldedSearchRegex(query) {
  const needle = foldDiacritics(String(query ?? '').trim())
  if (!needle) return null
  const source = [...needle]
    .map((ch) => (FOLD_VARIANTS.get(ch) || escapeRegex(ch)) + COMBINING_MARKS)
    .join('')
  return new RegExp(source, 'i')
}

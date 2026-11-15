import GlobalVocabulary from '../models/GlobalVocabulary.js'
import AuditLog from '../models/AuditLog.js'
import asyncHandler from '../utils/asyncHandler.js'
import ErrorResponse from '../utils/ErrorResponse.js'

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const parsePositiveInteger = (value, fallback, max = Number.MAX_SAFE_INTEGER) => {
  const parsed = Number.parseInt(value, 10)
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, max) : fallback
}

/**
 * @desc    Get global vocabulary library with search, filter, and pagination
 * @route   GET /api/admin/global-vocabulary
 * @access  Private (Admin)
 */
export const getGlobalVocabularies = asyncHandler(async (req, res) => {
  const { search, cefr, awl, page = 1, limit = 10 } = req.query
  const query = {}

  // Filters
  if (cefr) {
    query.cefr = cefr
  }
  if (awl) {
    if (awl === 'yes') {
      query.awl = { $ne: '' }
    } else if (awl === 'no') {
      query.awl = ''
    } else {
      query.awl = { $regex: awl, $options: 'i' }
    }
  }
  if (search) {
    const safeSearch = escapeRegex(String(search).trim())
    query.$or = [
      { word: { $regex: safeSearch, $options: 'i' } },
      { definition: { $regex: safeSearch, $options: 'i' } }
    ]
  }

  const pageNum = parsePositiveInteger(page, 1)
  const limitNum = parsePositiveInteger(limit, 10, 100)
  const skip = (pageNum - 1) * limitNum

  const words = await GlobalVocabulary.find(query)
    .sort({ word: 1 })
    .skip(skip)
    .limit(limitNum)

  const total = await GlobalVocabulary.countDocuments(query)

  // Get statistics for the dashboard/widget
  const totalCount = await GlobalVocabulary.countDocuments()
  const cefrStats = await GlobalVocabulary.aggregate([
    { $group: { _id: '$cefr', count: { $sum: 1 } } }
  ])
  const awlCount = await GlobalVocabulary.countDocuments({ awl: { $ne: '' } })

  const cefrMap = cefrStats.reduce((acc, curr) => {
    acc[curr._id] = curr.count
    return acc
  }, { A1: 0, A2: 0, B1: 0, B2: 0, C1: 0, C2: 0 })

  res.status(200).json({
    success: true,
    data: words,
    pagination: {
      total,
      page: pageNum,
      limit: limitNum,
      pages: Math.ceil(total / limitNum)
    },
    stats: {
      totalCount,
      awlCount,
      cefr: cefrMap
    }
  })
})

/**
 * @desc    Get global vocabulary library statistics
 * @route   GET /api/admin/global-vocabulary/stats
 * @access  Private (Admin)
 */
export const getGlobalVocabularyStats = asyncHandler(async (req, res) => {
  const [totalCount, awlCount, cefrStats] = await Promise.all([
    GlobalVocabulary.countDocuments(),
    GlobalVocabulary.countDocuments({ awl: { $ne: '' } }),
    GlobalVocabulary.aggregate([
      { $group: { _id: '$cefr', count: { $sum: 1 } } }
    ])
  ])

  // Unknown/null CEFR values are grouped under 'unknown' instead of crashing.
  const cefr = { A1: 0, A2: 0, B1: 0, B2: 0, C1: 0, C2: 0 }
  for (const { _id, count } of cefrStats) {
    if (_id && Object.prototype.hasOwnProperty.call(cefr, _id)) {
      cefr[_id] = count
    } else {
      cefr.unknown = (cefr.unknown || 0) + count
    }
  }

  res.status(200).json({
    success: true,
    data: { totalCount, awlCount, cefr }
  })
})

/**
 * @desc    Get a single global vocabulary by ID
 * @route   GET /api/admin/global-vocabulary/:id
 * @access  Private (Admin)
 */
export const getGlobalVocabularyById = asyncHandler(async (req, res) => {
  const word = await GlobalVocabulary.findById(req.params.id)

  if (!word) {
    throw new ErrorResponse('Word not found in global vocabulary', 404)
  }

  res.status(200).json({
    success: true,
    data: word
  })
})

/**
 * @desc    Create a new global vocabulary word
 * @route   POST /api/admin/global-vocabulary
 * @access  Private (Admin)
 */
export const createGlobalVocabulary = asyncHandler(async (req, res) => {
  const { word, ipa, partOfSpeech, definition, cefr, awl } = req.body

  if (!word || !definition) {
    throw new ErrorResponse('Word and definition are required', 400)
  }

  const normalizedWord = word.trim().toLowerCase()

  // Check if exists
  const existing = await GlobalVocabulary.findOne({ word: normalizedWord })
  if (existing) {
    throw new ErrorResponse('Word already exists in global vocabulary database', 400)
  }

  const newWord = await GlobalVocabulary.create({
    word: normalizedWord,
    ipa: ipa ? ipa.trim() : '',
    partOfSpeech: partOfSpeech || 'noun',
    definition: definition.trim(),
    cefr: cefr || 'B1',
    awl: awl ? awl.trim() : ''
  })

  // Create Audit Log
  await AuditLog.create({
    user: req.user._id,
    actorName: req.user.name || '',
    actorEmail: req.user.email || '',
    actorRole: req.user.role || '',
    action: 'CREATE_GLOBAL_VOCABULARY',
    targetType: 'GlobalVocabulary',
    targetId: newWord._id.toString(),
    details: { word: normalizedWord }
  })

  res.status(201).json({
    success: true,
    data: newWord
  })
})

/**
 * @desc    Update a global vocabulary word
 * @route   PUT /api/admin/global-vocabulary/:id
 * @access  Private (Admin)
 */
export const updateGlobalVocabulary = asyncHandler(async (req, res) => {
  const { word, ipa, partOfSpeech, definition, cefr, awl } = req.body

  let vocabulary = await GlobalVocabulary.findById(req.params.id)
  if (!vocabulary) {
    throw new ErrorResponse('Word not found in global vocabulary', 404)
  }

  const oldWord = vocabulary.word
  const normalizedWord = word ? word.trim().toLowerCase() : vocabulary.word

  // Check if new word name clashes with another word
  if (normalizedWord !== oldWord) {
    const existing = await GlobalVocabulary.findOne({ word: normalizedWord })
    if (existing) {
      throw new ErrorResponse('New word name already exists in database', 400)
    }
  }

  vocabulary.word = normalizedWord
  vocabulary.ipa = ipa !== undefined ? ipa.trim() : vocabulary.ipa
  vocabulary.partOfSpeech = partOfSpeech || vocabulary.partOfSpeech
  vocabulary.definition = definition !== undefined ? definition.trim() : vocabulary.definition
  vocabulary.cefr = cefr || vocabulary.cefr
  vocabulary.awl = awl !== undefined ? awl.trim() : vocabulary.awl

  const updatedWord = await vocabulary.save()

  // Create Audit Log
  await AuditLog.create({
    user: req.user._id,
    actorName: req.user.name || '',
    actorEmail: req.user.email || '',
    actorRole: req.user.role || '',
    action: 'UPDATE_GLOBAL_VOCABULARY',
    targetType: 'GlobalVocabulary',
    targetId: updatedWord._id.toString(),
    details: {
      oldWord,
      newWord: normalizedWord,
      fieldsUpdated: Object.keys(req.body)
    }
  })

  res.status(200).json({
    success: true,
    data: updatedWord
  })
})

/**
 * @desc    Delete a global vocabulary word
 * @route   DELETE /api/admin/global-vocabulary/:id
 * @access  Private (Admin)
 */
export const deleteGlobalVocabulary = asyncHandler(async (req, res) => {
  const vocabulary = await GlobalVocabulary.findById(req.params.id)
  if (!vocabulary) {
    throw new ErrorResponse('Word not found in global vocabulary', 404)
  }

  const wordName = vocabulary.word

  await vocabulary.deleteOne()

  // Create Audit Log
  await AuditLog.create({
    user: req.user._id,
    actorName: req.user.name || '',
    actorEmail: req.user.email || '',
    actorRole: req.user.role || '',
    action: 'DELETE_GLOBAL_VOCABULARY',
    targetType: 'GlobalVocabulary',
    targetId: req.params.id,
    details: { word: wordName }
  })

  res.status(200).json({
    success: true,
    message: `Word '${wordName}' has been successfully deleted`
  })
})

/**
 * @desc    Import global vocabulary from a JSON array (batch upsert)
 * @route   POST /api/admin/global-vocabulary/import
 * @access  Private (Admin)
 */
export const importGlobalVocabularies = asyncHandler(async (req, res) => {
  const { words } = req.body

  if (!words || !Array.isArray(words)) {
    throw new ErrorResponse('Please provide an array of words to import', 400)
  }

  if (words.length === 0) {
    return res.status(200).json({
      success: true,
      createdCount: 0,
      updatedCount: 0,
      unchangedCount: 0,
      message: 'No words to process'
    })
  }

  // Pre-validate & format data, keeping track of errors
  const validOpsMap = new Map()
  const errors = []

  const allowedPartsOfSpeech = ['noun', 'verb', 'adjective', 'adverb', 'pronoun', 'preposition', 'conjunction', 'interjection', 'phrase', 'other']
  const allowedCefr = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2']

  words.forEach((item, index) => {
    const lineNum = Number.isInteger(item?.line) && item.line > 0 ? item.line : index + 1

    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      errors.push({ line: lineNum, code: 'ROW_NOT_OBJECT', message: 'Dữ liệu dòng phải là một đối tượng từ vựng hợp lệ' })
      return
    }

    const rawWord = item.word || item.Word
    const rawDef = item.definition || item.Definition
    const rawIpa = item.ipa || item.IPA || ''
    const rawPos = item.partOfSpeech || item.partOfSpeechVal || item['Part of Speech'] || 'noun'
    const rawCefr = item.cefr || item.CEFR || 'B1'
    const rawAwl = item.awl || item.AWL || ''

    if (typeof rawWord !== 'string' || !rawWord.trim()) {
      errors.push({ line: lineNum, code: 'WORD_REQUIRED', message: 'Từ vựng (Word) không được để trống' })
      return
    }

    if (typeof rawDef !== 'string' || !rawDef.trim()) {
      errors.push({ line: lineNum, word: rawWord, code: 'DEFINITION_REQUIRED', message: 'Định nghĩa (Definition) không được để trống' })
      return
    }

    if ([rawIpa, rawPos, rawCefr, rawAwl].some(value => typeof value !== 'string')) {
      errors.push({ line: lineNum, word: rawWord, code: 'FIELDS_NOT_STRING', message: 'IPA, từ loại, CEFR và AWL phải là chuỗi ký tự' })
      return
    }

    const word = rawWord.trim().toLowerCase()
    const definition = rawDef.trim()
    const ipa = rawIpa.trim()
    const partOfSpeech = rawPos.trim().toLowerCase()
    const cefr = rawCefr.trim().toUpperCase()
    const awl = rawAwl.trim()

    // Validate POS
    if (!allowedPartsOfSpeech.includes(partOfSpeech)) {
      errors.push({ line: lineNum, word, code: 'POS_INVALID', value: partOfSpeech, allowed: allowedPartsOfSpeech, message: `Từ loại '${partOfSpeech}' không hợp lệ. Phải là một trong: ${allowedPartsOfSpeech.join(', ')}` })
      return
    }

    // Validate CEFR
    if (!allowedCefr.includes(cefr)) {
      errors.push({ line: lineNum, word, code: 'CEFR_INVALID', value: cefr, allowed: allowedCefr, message: `Cấp độ CEFR '${cefr}' không hợp lệ. Phải là một trong: ${allowedCefr.join(', ')}` })
      return
    }

    validOpsMap.set(word, {
      word,
      ipa,
      partOfSpeech,
      definition,
      cefr,
      awl
    })
  })

  const validOps = Array.from(validOpsMap.values())

  // Perform bulk upsert operations
  let createdCount = 0
  let updatedCount = 0
  let unchangedCount = 0

  if (validOps.length > 0) {
    const existingVocabularies = await GlobalVocabulary.find({
      word: { $in: validOps.map(op => op.word) }
    }).select('word ipa partOfSpeech definition cefr awl')
    const existingByWord = new Map(existingVocabularies.map(item => [item.word, item]))
    const fields = ['ipa', 'partOfSpeech', 'definition', 'cefr', 'awl']
    const changedOps = []

    validOps.forEach(op => {
      const existing = existingByWord.get(op.word)
      if (!existing) {
        createdCount += 1
        changedOps.push(op)
        return
      }

      if (fields.some(field => (existing[field] || '') !== (op[field] || ''))) {
        updatedCount += 1
        changedOps.push(op)
      } else {
        unchangedCount += 1
      }
    })

    const bulkOps = changedOps.map(op => ({
      updateOne: {
        filter: { word: op.word },
        update: { $set: op },
        upsert: true
      }
    }))

    if (bulkOps.length > 0) {
      await GlobalVocabulary.bulkWrite(bulkOps)
    }

    // Create Audit Log
    await AuditLog.create({
      user: req.user._id,
      actorName: req.user.name || '',
      actorEmail: req.user.email || '',
      actorRole: req.user.role || '',
      action: 'IMPORT_GLOBAL_VOCABULARY',
      targetType: 'GlobalVocabulary',
      details: {
        totalImported: validOps.length,
        createdCount,
        updatedCount,
        unchangedCount,
        errorsCount: errors.length
      }
    })
  }

  res.status(200).json({
    success: true,
    createdCount,
    updatedCount,
    unchangedCount,
    errors,
    message: `Đã xử lý xong. Thêm mới: ${createdCount}, Cập nhật: ${updatedCount}, Không đổi: ${unchangedCount}, Lỗi: ${errors.length}`
  })
})

/**
 * @desc    Export all global vocabulary words to a CSV file
 * @route   GET /api/admin/global-vocabulary/export
 * @access  Private (Admin)
 */
export const exportGlobalVocabularies = asyncHandler(async (req, res) => {
  // The collection can be large and every row used to be held in memory to build
  // one CSV string. Stream sorted pages instead so the response starts immediately
  // and memory stays bounded by the page size.
  const PAGE_SIZE = 1000
  const csvCell = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`

  // Persist the audit record before sending any CSV bytes; response streaming
  // cannot be rolled back if the audit write fails afterwards.
  const totalWords = await GlobalVocabulary.countDocuments()
  await AuditLog.create({
    user: req.user._id,
    actorName: req.user.name || '',
    actorEmail: req.user.email || '',
    actorRole: req.user.role || '',
    action: 'EXPORT_GLOBAL_VOCABULARY',
    targetType: 'GlobalVocabulary',
    details: { totalWordsExported: totalWords }
  })

  res.setHeader('Content-Type', 'text/csv; charset=utf-8')
  res.setHeader('Content-Disposition', 'attachment; filename=global_vocabulary.csv')

  // res.write() returns false once the socket buffer exceeds highWaterMark.
  // Ignoring it lets a slow client accumulate the whole file in memory. A
  // disconnected client never emits 'drain', so 'close' must settle too.
  let clientGone = false
  res.on('close', () => { clientGone = true })
  const writeChunk = (chunk) => new Promise((resolve) => {
    if (clientGone) return resolve()
    if (res.write(chunk)) return resolve()
    const done = () => { res.off('drain', done); res.off('close', done); resolve() }
    res.once('drain', done)
    res.once('close', done)
  })

  await writeChunk('\ufeffsep=,\nWord,IPA,Part of Speech,Definition,CEFR,AWL\n')

  let lastWord = null
  for (;;) {
    const query = lastWord === null ? {} : { word: { $gt: lastWord } }
    const page = await GlobalVocabulary.find(query)
      .sort({ word: 1 })
      .limit(PAGE_SIZE)
      .lean()
    if (page.length === 0) break
    await writeChunk(page.map((v) => [
      csvCell(v.word), csvCell(v.ipa), csvCell(v.partOfSpeech),
      csvCell(v.definition), csvCell(v.cefr), csvCell(v.awl),
    ].join(',') + '\n').join(''))
    lastWord = page[page.length - 1].word
    if (page.length < PAGE_SIZE) break
  }
  res.end()
})

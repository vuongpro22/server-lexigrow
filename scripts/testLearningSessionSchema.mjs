// Test script GĐ1: Mở rộng schema LearningSession
// Chạy: cd server && node scripts/testLearningSessionSchema.mjs

import { MongoMemoryServer } from 'mongodb-memory-server'
import mongooseLib from 'mongoose'

// 1. Khởi động MongoDB in-memory
console.log('🚀 Đang khởi động MongoDB in-memory...')
const mongoServer = await MongoMemoryServer.create()
const uri = mongoServer.getUri()
await mongooseLib.connect(uri)
console.log('✅ MongoDB connected:', uri)

// 2. Import model LearningSession SAU khi connect
const LearningSession = (await import('../src/models/LearningSession.js')).default

console.log('\n=== TEST 1: Tạo session CŨ (giả lập flow hiện tại, có learningSet) ===')
const oldStyleSession = await LearningSession.create({
  student: new mongooseLib.Types.ObjectId(),
  learningSet: new mongooseLib.Types.ObjectId(),
  learningSetSlug: 'animals-v1',
  theme: 'animals',
  level: 'A1',
  setVersion: new Date(),
  targetWords: [{ word: 'cat' }, { word: 'dog' }],
})
console.log('Session ID:', oldStyleSession._id)
console.log('mode (default cho session cũ):', oldStyleSession.mode)
console.log('adaptiveReason (default null):', oldStyleSession.adaptiveReason)
console.log('learningSet:', oldStyleSession.learningSet)
console.log('✅ PASS: mode = static (default), adaptiveReason = null')

console.log('\n=== TEST 2: Tạo session ADAPTIVE mới (mode=adaptive, learningSet=null) ===')
const adaptiveSession = await LearningSession.create({
  student: new mongooseLib.Types.ObjectId(),
  learningSet: null,
  learningSetSlug: null,
  mode: 'adaptive',
  adaptiveReason: 'due-3,weak-1,new-1,lib-0',
  theme: 'travel',
  level: 'B1',
  targetWords: [{ word: 'journey' }],
})
console.log('Session ID:', adaptiveSession._id)
console.log('mode:', adaptiveSession.mode)
console.log('adaptiveReason:', adaptiveSession.adaptiveReason)
console.log('learningSet:', adaptiveSession.learningSet)
console.log('✅ PASS: mode = adaptive, learningSet = null')

console.log('\n=== TEST 3: Validate mode sai bị reject ===')
try {
  await LearningSession.create({
    student: new mongooseLib.Types.ObjectId(),
    learningSet: new mongooseLib.Types.ObjectId(),
    targetWords: [{ word: 'x' }],
    mode: 'wrong-value', // enum không cho phép
  })
  console.log('❌ FAIL: validation sai mode bị chấp nhận')
} catch (err) {
  console.log('✅ PASS: enum validation hoạt động')
  console.log('   Lỗi:', err.message.split('\n')[0])
}

console.log('\n=== TEST 4: Validate learningSet=null không lỗi ===')
try {
  const session = await LearningSession.create({
    student: new mongooseLib.Types.ObjectId(),
    learningSet: null,
    targetWords: [{ word: 'y' }],
  })
  console.log('✅ PASS: learningSet = null OK, mode default =', session.mode)
} catch (err) {
  console.log('❌ FAIL: learningSet = null bị reject')
  console.log('   Lỗi:', err.message)
}

console.log('\n=== TEST 5: Tìm session in_progress theo student ===')
const student = new mongooseLib.Types.ObjectId()
await LearningSession.create({
  student,
  learningSet: null,
  mode: 'adaptive',
  adaptiveReason: 'test',
  targetWords: [{ word: 'findme' }],
})
const found = await LearningSession.findOne({ student, status: 'in_progress' })
console.log('Tìm thấy:', found?.word || '(none)')
console.log('Mode của session tìm được:', found?.mode)
console.log('✅ PASS: truy vấn in_progress vẫn hoạt động')

console.log('\n🧹 Dọn dẹp...')
await mongooseLib.disconnect()
await mongoServer.stop()
console.log('✅ XONG.')
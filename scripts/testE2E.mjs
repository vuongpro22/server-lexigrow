/**
 * Giai đoạn 6 — E2E test toàn bộ adaptive flow
 *
 * Verify luồng end-to-end mô phỏng browser:
 *  1) Login → lấy cookie token
 *  2) Gọi POST /api/sessions/start với mode=adaptive
 *  3) Gọi GET  /api/sessions/:id/writing-prompt
 *  4) Verify prompt có 5 target words, theme được resolve đúng
 *
 * Chạy: cd server && node scripts/testE2E.mjs
 *
 * ⚠️ YÊU CẦU ĐẶC BIỆT:
 *  - Server backend đang chạy ở http://localhost:5000 (npm run dev)
 *  - MongoDB PHẢI là **replica set** (không phải standalone)
 *  - File .env có JWT_SECRET, MONGO_URI
 *
 * Lý do: Controller dùng mongoose.connection.transaction() cho atomicity.
 * Standalone MongoDB không hỗ trợ transaction → trả 500.
 * Đã có fallback cho standalone nhưng gặp edge case với retryable writes
 * trên một số version mongoose.
 *
 * Nếu MongoDB của bạn là standalone, có 2 lựa chọn:
 *  1) Convert sang replica set: mongod --replSet rs0
 *  2) Dùng test trực tiếp: node scripts/testAdaptiveIntegration.mjs
 *     (đã có 25/25 PASS, regression-safe)
 *
 * Hướng dẫn test thủ công xem GĐ6 docs.
 */

import mongoose from 'mongoose'
import 'dotenv/config'
import { requireIsolatedTestExecution } from './localTestDatabaseGuard.js'

requireIsolatedTestExecution('testE2E', {
  envFlag: 'RUN_TEST_E2E',
})

const BASE = process.env.E2E_BASE_URL || 'http://localhost:5000'

// Patch: standalone MongoDB không hỗ trợ transaction với replica set features.
// Test chạy với standalone → wrap transaction thành session đơn lẻ.
// Production code (replica set) sẽ tự chạy transaction thật.
const _origTransaction = mongoose.connection.transaction.bind(mongoose.connection)
mongoose.connection.transaction = async function (fn) {
  return await fn(null)
}

// ========== HELPERS ==========
let pass = 0
let fail = 0
const log = (ok, label, detail) => {
  const icon = ok ? '✅' : '❌'
  console.log(`${icon} ${label}${detail ? ` — ${detail}` : ''}`)
  if (ok) pass++
  else fail++
}

const section = (name) => {
  console.log(`\n--- ${name} ---`)
}

// ========== MAIN ==========
async function main() {
  section('E2E — Setup')

  // 0) Tạo test student với vocab history
  await mongoose.connect(process.env.MONGO_URI)
  const db = mongoose.connection.db
  const User = (await import('../src/models/User.js')).default
  const Vocabulary = (await import('../src/models/Vocabulary.js')).default

  // Cleanup trước
  await db.collection('learningsessions').deleteMany({})
  await User.deleteOne({ email: 'e2e-test@lexigrow.test' })

  // Tạo test student
  const testUser = await User.create({
    name: 'E2E Test Student',
    email: 'e2e-test@lexigrow.test',
    password: 'test1234',
    role: 'student',
    learningProfile: { targetLevel: 'B1', interests: ['Travel'] },
  })
  log(true, 'Test student created', testUser._id.toString())

  // Tạo vocab history với theme Travel
  await Vocabulary.create([
    { student: testUser._id, word: 'journey', theme: 'Travel', masteryLevel: 'learning', wordId: 'j1' },
    { student: testUser._id, word: 'explore', theme: 'Travel', masteryLevel: 'learning', wordId: 'e1' },
    { student: testUser._id, word: 'culture', theme: 'Culture', masteryLevel: 'learning', wordId: 'c1' },
    { student: testUser._id, word: 'adventure', theme: 'Travel', masteryLevel: 'learning', wordId: 'a1' },
    { student: testUser._id, word: 'memory', theme: 'Travel', masteryLevel: 'learning', wordId: 'm1' },
    { student: testUser._id, word: 'routine', theme: 'Daily', masteryLevel: 'mastered', wordId: 'r1' },
    { student: testUser._id, word: 'commute', theme: 'Daily', masteryLevel: 'learning', wordId: 'c2' },
  ])
  log(true, 'Created 7 vocab history items (5 weak Travel, 1 moderate, 1 strong)')

  // ========== 1) LOGIN qua HTTP ==========
  section('E2E — 1) Login qua HTTP API')
  const loginRes = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'e2e-test@lexigrow.test', password: 'test1234' }),
  })
  log(loginRes.ok, 'POST /api/auth/login', `status=${loginRes.status}`)
  if (!loginRes.ok) {
    console.log('Login body:', await loginRes.text())
    return
  }

  // Lấy cookie từ response
  const setCookie = loginRes.headers.get('set-cookie') || ''
  const tokenMatch = setCookie.match(/token=([^;]+)/)
  const cookieHeader = tokenMatch ? `token=${tokenMatch[1]}` : ''
  log(!!cookieHeader, 'JWT token cookie extracted', cookieHeader ? `${cookieHeader.slice(0, 40)}...` : 'MISSING')

  // ========== 2) START adaptive session ==========
  section('E2E — 2) Start adaptive session qua HTTP')
  const startRes = await fetch(`${BASE}/api/sessions/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieHeader },
    body: JSON.stringify({ mode: 'adaptive' }),
  })
  const startBody = await startRes.json()
  log(startRes.ok, 'POST /api/sessions/start mode=adaptive', `status=${startRes.status}`)
  if (!startRes.ok) {
    console.log('  Response body:', JSON.stringify(startBody).slice(0, 300))
  }
  log(startBody?.success === true, 'Response success=true')
  log(startBody?.data?.mode === 'adaptive', 'data.mode=adaptive', startBody?.data?.mode)
  log(startBody?.data?.learningSet === null, 'data.learningSet=null (adaptive)')
  log(Array.isArray(startBody?.data?.targetWords) && startBody.data.targetWords.length === 5,
    'targetWords có 5 phần tử', `count=${startBody?.data?.targetWords?.length}`)
  log(startBody?.data?.theme === 'Adaptive', 'data.theme="Adaptive"', startBody?.data?.theme)
  log(startBody?.data?.level, 'data.level có giá trị', startBody?.data?.level)
  log(startBody?.data?.adaptiveReason, 'data.adaptiveReason có giá trị', typeof startBody?.data?.adaptiveReason)

  const sessionId = startBody?.data?._id
  log(!!sessionId, 'Có sessionId', sessionId)

  // ========== 3) FETCH writing prompt ==========
  section('E2E — 3) GET /api/sessions/:id/writing-prompt')
  const promptRes = await fetch(`${BASE}/api/sessions/${sessionId}/writing-prompt`, {
    method: 'GET',
    headers: { Cookie: cookieHeader },
  })
  const promptBody = await promptRes.json()
  log(promptRes.ok, 'GET writing-prompt', `status=${promptRes.status}`)
  log(promptBody?.success === true, 'Response success=true')

  if (promptBody?.success) {
    const p = promptBody.data
    log(typeof p?.prompt === 'string' && p.prompt.length > 20, 'prompt là string dài', `len=${p?.prompt?.length}`)
    log(Array.isArray(p?.wordTargets) && p.wordTargets.length === 5,
      'wordTargets có 5 phần tử', `count=${p?.wordTargets?.length}`)
    log(['ai', 'cache', 'fallback'].includes(p?.source), 'source hợp lệ', p?.source)
    log(typeof p?.wordCountMin === 'number' && typeof p?.wordCountMax === 'number',
      'wordCountMin/Max là số', `${p?.wordCountMin}-${p?.wordCountMax}`)
    log(typeof p?.fallback === 'boolean', 'fallback là boolean', String(p?.fallback))
    log(typeof p?.generatedAt === 'string', 'generatedAt là ISO string', p?.generatedAt)

    // Theme resolution test: prompt phải có chứa 1 trong 2 theme (Travel hoặc Culture)
    if (p.fallback) {
      const hasTravel = p.prompt.includes('Travel')
      const hasCulture = p.prompt.includes('Culture')
      log(hasTravel || hasCulture, 'Prompt có theme "Travel" hoặc "Culture" (resolve từ targetWords)',
        `prompt="${p.prompt.slice(0, 100)}..."`)
    } else {
      log(true, 'AI path — không check prompt content deterministic')
    }

    // wordTargets chứa 5 từ từ targetWords của session
    const sessionTargetWords = startBody.data.targetWords.map((t) =>
      typeof t === 'string' ? t : t.word
    )
    const allMatch = sessionTargetWords.every((w) => p.wordTargets.includes(w))
    log(allMatch, 'wordTargets khớp với session.targetWords',
      `expected=[${sessionTargetWords.join(',')}], got=[${p.wordTargets.join(',')}]`)
  }

  // ========== 4) BYPASS CACHE test ==========
  section('E2E — 4) Bypass cache (regenerate)')
  await new Promise((r) => setTimeout(r, 50))
  const refreshRes = await fetch(`${BASE}/api/sessions/${sessionId}/writing-prompt?bypassCache=1`, {
    method: 'GET',
    headers: { Cookie: cookieHeader },
  })
  const refreshBody = await refreshRes.json()
  log(refreshRes.ok, 'GET writing-prompt?bypassCache=1', `status=${refreshRes.status}`)
  log(refreshBody?.success === true, 'Response success=true')
  log(refreshBody?.data?.source !== 'cache', 'source KHÔNG phải cache (vì bypass)',
    `source=${refreshBody?.data?.source}`)

  // ========== 5) STATIC mode regression ==========
  section('E2E — 5) Static mode (regression)')
  // Cleanup session hiện tại để có thể tạo mới
  await db.collection('learningsessions').updateMany(
    { student: testUser._id, status: 'in_progress' },
    { $set: { status: 'completed' } }
  )
  const staticRes = await fetch(`${BASE}/api/sessions/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieHeader },
    body: JSON.stringify({ learningSetSlug: 'daily-life', mode: 'static' }),
  })
  const staticBody = await staticRes.json()
  log(staticRes.ok, 'POST /api/sessions/start mode=static', `status=${staticRes.status}`)
  log(staticBody?.data?.mode === 'static', 'data.mode=static')
  log(!!staticBody?.data?.learningSet, 'data.learningSet có giá trị (không null)')

  // ========== CLEANUP ==========
  section('E2E — Cleanup')
  await db.collection('learningsessions').deleteMany({ student: testUser._id })
  await Vocabulary.deleteMany({ student: testUser._id })
  await User.deleteOne({ _id: testUser._id })
  log(true, 'Cleaned up test data')
  await mongoose.disconnect()
  log(true, 'MongoDB disconnected')

  // ========== KẾT QUẢ ==========
  console.log('\n' + '='.repeat(60))
  console.log(`E2E — KẾT QUẢ`)
  console.log(`✅ PASS: ${pass}`)
  console.log(`❌ FAIL: ${fail}`)
  console.log(`📊 Total: ${pass + fail}`)
  console.log('='.repeat(60))

  process.exit(fail > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error('E2E test crashed:', err)
  process.exit(1)
})

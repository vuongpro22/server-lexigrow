import asyncHandler from '../utils/asyncHandler.js'
import { startAuthoritativeGame, submitAuthoritativeAnswer, finishAuthoritativeGame, heartbeatGameSession } from '../services/gameChallenge.service.js'

export const startGame = asyncHandler(async (req, res) => {
  const startKey = String(req.get('Idempotency-Key') || req.body?.requestId || '').trim()
  const data = await startAuthoritativeGame(
    req.user._id,
    req.params.gameKey,
    req.body?.config || {},
    startKey ? startKey.slice(0, 128) : null,
  )
  res.status(201).json({ success: true, data })
})

export const submitGameAnswer = asyncHandler(async (req, res) => {
  const data = await submitAuthoritativeAnswer(req.user._id, req.params.gameKey, req.params.id, req.body || {})
  res.json({ success: true, data })
})

export const finishGame = asyncHandler(async (req, res) => {
  const data = await finishAuthoritativeGame(req.user._id, req.params.gameKey, req.params.id)
  res.json({ success: true, data })
})

export const heartbeatGame = asyncHandler(async (req, res) => {
  const data = await heartbeatGameSession(req.user._id, req.params.gameKey, req.params.id)
  res.json({ success: true, data })
})

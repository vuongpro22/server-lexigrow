import mongoose from 'mongoose'

export const MAX_API_KEYS_PER_ACCOUNT = 20

// One provider account can hold several API keys. Key health (auth failures,
// per-key rate limits) lives on each key; provider-wide health (outages,
// network errors) stays on the account so one outage does not burn every key.
const apiKeySchema = new mongoose.Schema({
  label: { type: String, trim: true, maxlength: 60, default: '' },
  encryptedKey: { type: String, required: true, select: false },
  maskedKey: { type: String, default: '••••••••' },
  enabled: { type: Boolean, default: true },
  cooldownUntil: { type: Date, default: null },
  needsAttention: { type: Boolean, default: false },
  consecutiveFailures: { type: Number, min: 0, default: 0 },
  lastUsedAt: { type: Date, default: null },
  lastErrorCode: { type: String, default: '' },
  lastErrorAt: { type: Date, default: null },
}, { timestamps: true })

const aiProviderAccountSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 100 },
  provider: {
    type: String,
    enum: ['groq', 'gemini', 'openai-compatible'],
    required: true,
  },
  model: { type: String, required: true, trim: true, maxlength: 160 },
  inputCostPerMillionUsd: { type: Number, min: 0, default: null },
  outputCostPerMillionUsd: { type: Number, min: 0, default: null },
  baseUrl: { type: String, trim: true, maxlength: 300, default: '' },
  // Legacy single key. Accounts created before multi-key support keep it until
  // they are migrated into apiKeys; the gateway still reads it as a fallback.
  encryptedApiKey: { type: String, select: false },
  apiKeys: {
    type: [apiKeySchema],
    default: [],
    validate: {
      validator: (keys) => keys.length <= MAX_API_KEYS_PER_ACCOUNT,
      message: `An AI provider account can hold at most ${MAX_API_KEYS_PER_ACCOUNT} API keys`,
    },
  },
  enabled: { type: Boolean, default: true },
  priority: { type: Number, min: 0, max: 1000, default: 100 },
  routes: { type: [String], default: [] },
  cooldownUntil: { type: Date, default: null },
  needsAttention: { type: Boolean, default: false },
  consecutiveFailures: { type: Number, min: 0, default: 0 },
  lastUsedAt: { type: Date, default: null },
  lastErrorCode: { type: String, default: '' },
  lastErrorAt: { type: Date, default: null },
}, { timestamps: true })

aiProviderAccountSchema.index({ enabled: 1, provider: 1, priority: 1 })
aiProviderAccountSchema.index({ routes: 1, enabled: 1, priority: 1 })

export default mongoose.model('AIProviderAccount', aiProviderAccountSchema)

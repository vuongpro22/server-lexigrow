import { webcrypto } from 'node:crypto'
if (!globalThis.crypto) {
  globalThis.crypto = webcrypto
}
import mongoose from 'mongoose'
import PendingUser from '../models/PendingUser.js'
import { syncPendingUserExpiryIndexes } from '../utils/pendingUserIndexes.js'

const connectDB = async () => {
  const uri = process.env.MONGO_URI
  if (!uri) {
    console.error('❌ MongoDB Connection Error: MONGO_URI is not set. Create server/.env with MONGO_URI=mongodb://127.0.0.1:27017/lexigrow')
    process.exit(1)
  }

  try {
    // Auto detect standalone vs replica set qua connection string.
    // Standalone MongoDB không hỗ trợ retryWrites → phải tắt qua options object
    // (Mongoose 9 đôi khi ignore URI option cho retryWrites, phải pass vào options)
    const isStandalone =
      uri &&
      !uri.includes('replicaSet=') &&
      !uri.includes('mongodb+srv://')
    const connectOptions = isStandalone ? { retryWrites: false } : {}
    console.log(
      `🔌 Connecting to MongoDB ${isStandalone ? '(standalone, retryWrites=false)' : '(replica set)'}: ${uri.replace(/\/\/[^@]+@/, '//***:***@')}`,
    )
    const conn = await mongoose.connect(uri, connectOptions)
    console.log(`✅ MongoDB Connected: ${conn.connection.host}`)
    await syncPendingUserExpiryIndexes(PendingUser.collection)
    
    // Auto verify legacy users
    try {
      const User = (await import('../models/User.js')).default
      await User.updateMany({ isVerified: { $exists: false } }, { $set: { isVerified: true } })
      await User.updateMany({ accountStatus: { $exists: false } }, { $set: { accountStatus: 'active' } })
    } catch (migError) {
      console.error(`Migration error: ${migError.message}`)
    }

    // Ensure AIRequest unique index for idempotency ledger
    try {
      const AIRequest = (await import('../models/AIRequest.js')).default
      await AIRequest.syncIndexes()
    } catch (idxError) {
      console.error(`AIRequest index sync error: ${idxError.message}`)
    }

    // Seed default system configs and migrate encryption if key is configured
    try {
      const Config = (await import('../models/Config.js')).default
      const AIProviderAccount = (await import('../models/AIProviderAccount.js')).default
      const { DEFAULT_ANALYSIS_PROMPT, AI_CONFIG_SECRET_KEYS } = await import('../services/ai.service.js')
      const { encryptSecret, decryptSecret, isEncryptedSecret } = await import('../utils/secretCrypto.js')
      
      // Re-encrypt legacy plaintext/v1 keys with dedicated key if configured
      if (process.env.AI_PROVIDER_ENCRYPTION_KEY || process.env.NODE_ENV === 'test') {
        try {
          const legacyConfigs = await Config.find({ key: { $in: AI_CONFIG_SECRET_KEYS }, value: { $nin: ['', null] } })
          for (const config of legacyConfigs) {
            if (isEncryptedSecret(config.value) && config.value.startsWith('v2.')) continue
            const plaintext = isEncryptedSecret(config.value) ? decryptSecret(config.value) : String(config.value)
            config.value = encryptSecret(plaintext)
            await config.save()
          }

          const providerAccounts = await AIProviderAccount.find({ encryptedApiKey: { $exists: true, $ne: '' } }).select('+encryptedApiKey')
          for (const account of providerAccounts) {
            if (isEncryptedSecret(account.encryptedApiKey) && account.encryptedApiKey.startsWith('v2.')) continue
            const plaintext = isEncryptedSecret(account.encryptedApiKey)
              ? decryptSecret(account.encryptedApiKey)
              : String(account.encryptedApiKey)
            account.encryptedApiKey = encryptSecret(plaintext)
            await account.save()
          }

          const multiKeyAccounts = await AIProviderAccount.find({ 'apiKeys.0': { $exists: true } }).select('+apiKeys.encryptedKey')
          for (const account of multiKeyAccounts) {
            let changed = false
            for (const key of account.apiKeys) {
              if (!key.encryptedKey || (isEncryptedSecret(key.encryptedKey) && key.encryptedKey.startsWith('v2.'))) continue
              const plaintext = isEncryptedSecret(key.encryptedKey) ? decryptSecret(key.encryptedKey) : String(key.encryptedKey)
              key.encryptedKey = encryptSecret(plaintext)
              changed = true
            }
            if (changed) await account.save()
          }
        } catch (migErr) {
          console.error(`[AI Provider Migration Warning] ${migErr.message}`)
        }
      }

      // Ensure AI combos support practice_question_generation and writing_prompt_generation
      try {
        const AIModelCombo = (await import('../models/AIModelCombo.js')).default
        await AIModelCombo.updateMany(
          { enabled: true },
          { $addToSet: { routes: { $each: ['practice_question_generation', 'writing_prompt_generation'] } } }
        )
      } catch (comboErr) {
        // Non-blocking
      }

      const defaultConfigs = [
        { key: 'GROQ_API_KEY', value: process.env.GROQ_API_KEY || '', description: 'Groq API Key' },
        { key: 'GEMINI_API_KEY', value: process.env.GEMINI_API_KEY || '', description: 'Google Gemini API Key' },
        { key: 'GEMINI_MODEL', value: process.env.GEMINI_MODEL || '', description: 'Google Gemini Model' },
        { key: 'OPENAI_API_KEY', value: process.env.OPENAI_API_KEY || '', description: 'OpenAI API Key' },
        { key: 'LLAMA_API_KEY', value: process.env.LLAMA_API_KEY || '', description: 'Llama API Key' },
        { key: 'DEFAULT_AI_MODEL', value: 'llama-3.3-70b-versatile', description: 'Default AI Model for Analysis' },
        { key: 'DEFAULT_AI_COMBO', value: '', description: 'Active AI Model Combo ID (optional)' },
        { key: 'SYSTEM_ANALYSIS_PROMPT', value: DEFAULT_ANALYSIS_PROMPT, description: 'System Analysis Prompt Template' },
        { key: 'ALLOW_PASTE_ESSAY', value: 'true', description: 'Cho phép học sinh paste bài viết essay (true/false)' },
      ]

      for (const config of defaultConfigs) {
        const exists = await Config.findOne({ key: config.key })
        if (!exists) {
          const value = AI_CONFIG_SECRET_KEYS.includes(config.key) && config.value
            ? encryptSecret(config.value)
            : config.value
          await Config.create({ ...config, value })
          console.log(`🌱 Seeded default config: ${config.key}`)
        } else if (config.key === 'SYSTEM_ANALYSIS_PROMPT' && exists.value && (!exists.value.includes('lexicalResource') || !exists.value.includes('promptAdherence'))) {
          exists.value = DEFAULT_ANALYSIS_PROMPT
          await exists.save()
          console.log(`🔄 Upgraded outdated SYSTEM_ANALYSIS_PROMPT to current rubric schema`)
        }
      }
    } catch (configError) {
      console.error(`Config seeding error: ${configError.message}`)
      throw configError
    }
  } catch (error) {
    console.error(`❌ MongoDB Connection Error: ${error.message}`)
    process.exit(1)
  }
}

export default connectDB

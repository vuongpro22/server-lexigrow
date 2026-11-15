import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockFindOne } = vi.hoisted(() => ({
  mockFindOne: vi.fn(),
}))

vi.mock('../src/models/Config.js', () => ({
  default: {
    findOne: mockFindOne,
  },
}))

import { getConfigValue, AI_CONFIG_SECRET_KEYS } from '../src/services/ai.service.js'
import { encryptSecret } from '../src/utils/secretCrypto.js'

describe('getConfigValue encryption and security behavior', () => {
  beforeEach(() => {
    mockFindOne.mockReset()
  })

  it('defines the strict secret allowlist', () => {
    expect(AI_CONFIG_SECRET_KEYS).toContain('GROQ_API_KEY')
    expect(AI_CONFIG_SECRET_KEYS).toContain('GEMINI_API_KEY')
    expect(AI_CONFIG_SECRET_KEYS).toContain('OPENAI_API_KEY')
    expect(AI_CONFIG_SECRET_KEYS).toContain('LLAMA_API_KEY')
    expect(AI_CONFIG_SECRET_KEYS).not.toContain('HF_API_TOKEN')
  })

  it('returns plaintext value directly for non-secret configs', async () => {
    mockFindOne.mockResolvedValue({ key: 'DEFAULT_AI_MODEL', value: 'llama-3.3-70b-versatile' })
    const val = await getConfigValue('DEFAULT_AI_MODEL', 'fallback')
    expect(val).toBe('llama-3.3-70b-versatile')
  })

  it('transparently decrypts encrypted v2 secret in the allowlist', async () => {
    const rawKey = 'gsk_real_api_key_secret_value'
    const encrypted = encryptSecret(rawKey)

    mockFindOne.mockResolvedValue({ key: 'GROQ_API_KEY', value: encrypted })
    const val = await getConfigValue('GROQ_API_KEY', 'default')
    expect(val).toBe(rawKey)
  })

  it('throws an explicit error when secret decryption fails without leaking keys', async () => {
    const corruptedSecret = 'v2.bad_iv.bad_tag.bad_cipher'
    mockFindOne.mockResolvedValue({ key: 'GROQ_API_KEY', value: corruptedSecret })

    await expect(getConfigValue('GROQ_API_KEY', 'default')).rejects.toThrow(
      'Failed to decrypt configuration secret for "GROQ_API_KEY"',
    )
  })

  it('does not attempt to decrypt keys not in the secret allowlist', async () => {
    const pseudoCipher = 'v2.some.pseudo.ciphertext'
    mockFindOne.mockResolvedValue({ key: 'SYSTEM_ANALYSIS_PROMPT', value: pseudoCipher })

    const val = await getConfigValue('SYSTEM_ANALYSIS_PROMPT', 'default')
    expect(val).toBe(pseudoCipher)
  })

  it('returns default value when config document is missing in DB', async () => {
    mockFindOne.mockResolvedValue(null)
    const val = await getConfigValue('MISSING_KEY', 'my-default')
    expect(val).toBe('my-default')
  })
})

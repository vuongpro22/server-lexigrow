import { describe, expect, it } from 'vitest'
import {
  encryptSecret,
  decryptSecret,
  isEncryptedSecret,
  maskSecret,
} from '../src/utils/secretCrypto.js'

describe('secretCrypto utility', () => {
  it('encrypts and decrypts secret with v2 format', () => {
    const raw = 'gsk_test_secret_key_123456789'
    const encrypted = encryptSecret(raw)

    expect(encrypted.startsWith('v2.')).toBe(true)
    expect(isEncryptedSecret(encrypted)).toBe(true)

    const decrypted = decryptSecret(encrypted)
    expect(decrypted).toBe(raw)
  })

  it('correctly identifies encrypted vs unencrypted secrets', () => {
    expect(isEncryptedSecret('v2.something.tag.cipher')).toBe(true)
    expect(isEncryptedSecret('v1.something.tag.cipher')).toBe(true)
    expect(isEncryptedSecret('gsk_plain_text_key')).toBe(false)
    expect(isEncryptedSecret('')).toBe(false)
    expect(isEncryptedSecret(null)).toBe(false)
  })

  it('masks secret keys properly', () => {
    expect(maskSecret('short')).toBe('••••••••')
    expect(maskSecret('gsk_123456789_abcdef')).toBe('gsk••••••••def')
    expect(maskSecret('')).toBe('')
  })

  it('throws when encrypting empty or invalid input', () => {
    expect(() => encryptSecret('')).toThrow('Provider API key is required')
    expect(() => encryptSecret('   ')).toThrow('Provider API key is required')
    expect(() => encryptSecret(123)).toThrow('Provider API key is required')
  })

  it('throws on tampered or corrupted ciphertext', () => {
    const encrypted = encryptSecret('my-secret-key')
    const parts = encrypted.split('.')
    // tamper with ciphertext
    const corrupted = `${parts[0]}.${parts[1]}.${parts[2]}.corruptedPayload`
    expect(() => decryptSecret(corrupted)).toThrow('Encrypted provider key cannot be decrypted')
  })

  it('throws on invalid format', () => {
    expect(() => decryptSecret('not-a-valid-encrypted-string')).toThrow('Encrypted provider key is invalid')
    expect(() => decryptSecret('v3.invalid.version.payload')).toThrow('Encrypted provider key is invalid')
  })
})

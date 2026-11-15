import { describe, expect, it } from 'vitest'
import {
  isPrivateIPv4,
  isPrivateIPv6,
  validateSafeUrl,
} from '../src/utils/ssrfValidator.js'

describe('ssrfValidator utility', () => {
  describe('isPrivateIPv4', () => {
    it('detects loopback and RFC 1918 private IPv4 addresses', () => {
      expect(isPrivateIPv4('127.0.0.1')).toBe(true)
      expect(isPrivateIPv4('10.0.0.1')).toBe(true)
      expect(isPrivateIPv4('172.16.0.1')).toBe(true)
      expect(isPrivateIPv4('172.31.255.255')).toBe(true)
      expect(isPrivateIPv4('192.168.1.1')).toBe(true)
      expect(isPrivateIPv4('169.254.169.254')).toBe(true) // AWS/Cloud metadata
      expect(isPrivateIPv4('0.0.0.0')).toBe(true)
    })

    it('allows public IPv4 addresses', () => {
      expect(isPrivateIPv4('8.8.8.8')).toBe(false)
      expect(isPrivateIPv4('1.1.1.1')).toBe(false)
      expect(isPrivateIPv4('104.244.42.1')).toBe(false)
    })
  })

  describe('isPrivateIPv6', () => {
    it('detects loopback, link-local, and unique-local IPv6 addresses', () => {
      expect(isPrivateIPv6('::1')).toBe(true)
      expect(isPrivateIPv6('fe80::1')).toBe(true)
      expect(isPrivateIPv6('fc00::1')).toBe(true)
      expect(isPrivateIPv6('::ffff:127.0.0.1')).toBe(true)
      expect(isPrivateIPv6('::ffff:192.168.0.1')).toBe(true)
    })

    it('allows public IPv6 addresses', () => {
      expect(isPrivateIPv6('2606:4700:4700::1111')).toBe(false)
    })
  })

  describe('validateSafeUrl', () => {
    it('rejects URLs without HTTPS', async () => {
      await expect(validateSafeUrl('http://api.openai.com/v1')).rejects.toThrow('Provider URL must use HTTPS')
      await expect(validateSafeUrl('ftp://example.com')).rejects.toThrow('Provider URL must use HTTPS')
    })

    it('rejects URLs with embedded credentials', async () => {
      await expect(validateSafeUrl('https://user:pass@api.openai.com/v1')).rejects.toThrow('must not contain credentials')
    })

    it('rejects blocked hostnames', async () => {
      await expect(validateSafeUrl('https://localhost:8080/v1')).rejects.toThrow('Access to private or local network hosts is not allowed')
      await expect(validateSafeUrl('https://metadata.google.internal/v1')).rejects.toThrow('Access to private or local network hosts is not allowed')
      await expect(validateSafeUrl('https://myhost.internal/v1')).rejects.toThrow('Access to private or local network hosts is not allowed')
    })

    it('rejects private IP destinations', async () => {
      await expect(validateSafeUrl('https://127.0.0.1:8080/v1')).rejects.toThrow('private, loopback, or reserved IP')
      await expect(validateSafeUrl('https://10.0.0.5/v1')).rejects.toThrow('private, loopback, or reserved IP')
      await expect(validateSafeUrl('https://169.254.169.254/v1')).rejects.toThrow('private, loopback, or reserved IP')
    })
  })
})

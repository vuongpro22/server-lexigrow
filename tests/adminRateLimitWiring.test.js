import fs from 'node:fs'
import { describe, expect, it } from 'vitest'

// M6 regression guard: a router that forgets the limiter silently loses the
// protection, and no other test would notice. Assert the mount directly.
const ROUTERS = [
  'admin.routes.js',
  'admin.pricing.routes.js',
  'aiProvider.routes.js',
  'globalVocabulary.routes.js',
]

describe('every admin router mounts adminLimiter after the auth guards', () => {
  for (const name of ROUTERS) {
    it(name, () => {
      const src = fs.readFileSync(new URL('../src/routes/' + name, import.meta.url), 'utf8')
      const lines = src.split('\n')
      const protectAt = lines.findIndex((l) => /router\.use\(protect/.test(l))
      const adminAt = lines.findIndex((l) => /authorize\('admin'\)/.test(l))
      const limitAt = lines.findIndex((l) => /router\.use\(adminLimiter\)/.test(l))

      expect(protectAt, 'protect must be mounted').toBeGreaterThanOrEqual(0)
      expect(adminAt, 'authorize must be mounted').toBeGreaterThanOrEqual(0)
      expect(limitAt, 'adminLimiter must be mounted').toBeGreaterThanOrEqual(0)
      // Order matters: the limiter keys on req.user, which only exists after protect.
      expect(limitAt).toBeGreaterThan(protectAt)
      expect(limitAt).toBeGreaterThan(adminAt)
    })
  }
})

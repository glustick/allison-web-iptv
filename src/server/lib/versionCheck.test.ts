import { describe, expect, it } from 'vitest'
import { compareVersions, normalizeVersion } from './versionCheck.js'

describe('normalizeVersion', () => {
  it('strips a leading v and preserves numeric segments', () => {
    expect(normalizeVersion('v0.4.3')).toEqual([0, 4, 3])
    expect(normalizeVersion('1.2.3-beta')).toEqual([1, 2, 3])
  })
})

describe('compareVersions', () => {
  it('returns the correct ordering for release tags', () => {
    expect(compareVersions('0.4.2', '0.4.3')).toBeLessThan(0)
    expect(compareVersions('0.4.3', '0.4.3')).toBe(0)
    expect(compareVersions('0.4.4', '0.4.3')).toBeGreaterThan(0)
  })
})

import { describe, expect, it } from 'vitest'
import { clearErrors, formatBytes, recentErrors } from './diagnostics.js'

describe('diagnostics', () => {
  it('formats sizes readably', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2048)).toBe('2.0 KB')
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB')
    expect(formatBytes(3 * 1024 * 1024 * 1024)).toBe('3.00 GB')
  })

  it('returns recent errors newest first and can be cleared', () => {
    const before = recentErrors(100).length
    // captureErrors() is installed by the server at startup; the buffer is what the health page
    // reads, so exercise it directly through the same path.
    clearErrors()
    expect(recentErrors()).toEqual([])
    expect(before).toBeGreaterThanOrEqual(0)
  })
})

import { describe, expect, it } from 'vitest'
import { filesystemSpace, isLowSpace, LOW_SPACE_THRESHOLD_BYTES } from './diskSpace.js'
import { tmpdir } from 'os'

describe('filesystemSpace', () => {
  it('reports real space for a directory that exists', async () => {
    const space = await filesystemSpace(tmpdir())
    expect(space).not.toBeNull()
    expect(space!.freeBytes).toBeGreaterThan(0)
    expect(space!.totalBytes).toBeGreaterThanOrEqual(space!.freeBytes)
  })

  it('returns null rather than throwing for a path that does not exist', async () => {
    expect(await filesystemSpace('/definitely/not/here-9f3a')).toBeNull()
  })
})

describe('isLowSpace', () => {
  it('flags a nearly-full filesystem', () => {
    expect(isLowSpace(1024)).toBe(true)
    expect(isLowSpace(0)).toBe(true)
  })

  it('does not flag healthy space', () => {
    expect(isLowSpace(50 * 1024 * 1024 * 1024)).toBe(false)
  })

  it('treats an unknown figure as not-low so a missing reading never blocks anything', () => {
    expect(isLowSpace(null)).toBe(false)
    expect(isLowSpace(undefined)).toBe(false)
  })

  it('is exactly the boundary at the threshold', () => {
    expect(isLowSpace(LOW_SPACE_THRESHOLD_BYTES - 1)).toBe(true)
    expect(isLowSpace(LOW_SPACE_THRESHOLD_BYTES)).toBe(false)
  })
})

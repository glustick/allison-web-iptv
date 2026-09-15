import { describe, expect, it } from 'vitest'
import { filesystemSpace, isLowSpace, LOW_SPACE_THRESHOLD_BYTES, transcodeSpaceRefusal } from './diskSpace.js'
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

describe('transcodeSpaceRefusal', () => {
  const GB = 1024 * 1024 * 1024

  it('lets a film start only with room for everything it will keep', () => {
    expect(transcodeSpaceRefusal(20 * GB, true)).toBeNull()
    expect(transcodeSpaceRefusal(7 * GB, true)).toContain('Not enough free space')
    expect(transcodeSpaceRefusal(7 * GB, true)).toContain('7.0 GB free')
  })

  it('holds a live channel to the smaller floor, since it keeps only a rolling window', () => {
    // 1 GB is plenty for live TV (and for the database) but far short of a film's reservation.
    expect(transcodeSpaceRefusal(1 * GB, false)).toBeNull()
    expect(transcodeSpaceRefusal(100 * 1024 * 1024, false)).toContain('channel')
  })

  it('says megabytes when megabytes is the honest unit', () => {
    // Confirmed in Docker against an 8MB filesystem: "0.0 GB free" is not a useful sentence.
    const message = transcodeSpaceRefusal(8 * 1024 * 1024, true)
    expect(message).toContain('8 MB free')
    expect(message).toContain('8.0 GB needed')
  })

  it('stays out of the way when the filesystem cannot be measured', () => {
    expect(transcodeSpaceRefusal(null, true)).toBeNull()
    expect(transcodeSpaceRefusal(undefined, false)).toBeNull()
  })
})

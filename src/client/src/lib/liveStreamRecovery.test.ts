import { describe, it, expect } from 'vitest'
import { isPlayheadAtBufferEnd, liveRecoveryActions, LIVE_STALE_AFTER_MS } from './liveStreamRecovery.js'

const base = {
  now: 1_000_000,
  lastFragmentAt: 1_000_000 - 1000,
  playheadAtBufferEnd: true,
  hasFatalError: false,
  ended: false,
  kicksSinceLastFragment: 0
}

describe('liveRecoveryActions', () => {
  it('does nothing while fragments are arriving recently', () => {
    expect(liveRecoveryActions(base)).toEqual({ resumePlayback: false, kickLoader: false, reloadSource: false })
  })

  it('does nothing at exactly the boundary-minus-one of staleness', () => {
    expect(liveRecoveryActions({ ...base, lastFragmentAt: base.now - (LIVE_STALE_AFTER_MS - 1) }).kickLoader).toBe(false)
  })

  it('kicks the loader and resumes playback once stale and starved at the buffer end', () => {
    const actions = liveRecoveryActions({ ...base, lastFragmentAt: base.now - LIVE_STALE_AFTER_MS })
    expect(actions).toEqual({ resumePlayback: true, kickLoader: true, reloadSource: false })
  })

  it('does nothing when stale but the playhead still has buffer ahead (paused-but-loading)', () => {
    const actions = liveRecoveryActions({ ...base, lastFragmentAt: base.now - LIVE_STALE_AFTER_MS * 3, playheadAtBufferEnd: false })
    expect(actions).toEqual({ resumePlayback: false, kickLoader: false, reloadSource: false })
  })

  it('escalates to a full source reload after two kicks produced no fragments', () => {
    const actions = liveRecoveryActions({ ...base, lastFragmentAt: base.now - LIVE_STALE_AFTER_MS * 5, kicksSinceLastFragment: 2 })
    expect(actions).toEqual({ resumePlayback: true, kickLoader: false, reloadSource: true })
  })

  it('leaves recovery alone when a fatal error is already showing, or the stream ended', () => {
    for (const override of [{ hasFatalError: true }, { ended: true }] as const) {
      const actions = liveRecoveryActions({ ...base, lastFragmentAt: base.now - LIVE_STALE_AFTER_MS * 9, ...override })
      expect(actions).toEqual({ resumePlayback: false, kickLoader: false, reloadSource: false })
    }
  })

  it('does nothing before the first fragment ever arrives (startup belongs to hls.js)', () => {
    const actions = liveRecoveryActions({ ...base, lastFragmentAt: null })
    expect(actions).toEqual({ resumePlayback: false, kickLoader: false, reloadSource: false })
  })
})

describe('isPlayheadAtBufferEnd', () => {
  const videoOf = (currentTime: number, ranges: [number, number][]) => ({
    currentTime,
    buffered: {
      length: ranges.length,
      end: (i: number) => ranges[ranges.length - 1][1]
    }
  })

  it('treats an empty buffer as starved', () => {
    expect(isPlayheadAtBufferEnd(videoOf(0, []))).toBe(true)
  })

  it('treats a playhead at (or half a second shy of) the buffer end as starved', () => {
    expect(isPlayheadAtBufferEnd(videoOf(120, [[0, 120.4]]))).toBe(true)
    expect(isPlayheadAtBufferEnd(videoOf(120, [[0, 120]]))).toBe(true)
  })

  it('treats a playhead with buffer ahead as not starved', () => {
    expect(isPlayheadAtBufferEnd(videoOf(120, [[0, 180]]))).toBe(false)
  })
})

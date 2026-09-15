import { describe, expect, it } from 'vitest'
import { sessionIsIdle } from './transcodeIdle.js'

const IDLE_MS = 120_000
const now = 1_700_000_000_000

describe('sessionIsIdle', () => {
  it('reaps a session nobody has fetched from for the whole window', () => {
    // The reported case: playback stopped, nothing asked for output, ffmpeg kept writing.
    expect(sessionIsIdle(now, { hasPlaylist: true, lastServedAt: now - IDLE_MS }, IDLE_MS)).toBe(true)
    expect(sessionIsIdle(now, { hasPlaylist: true, lastServedAt: now - IDLE_MS - 1 }, IDLE_MS)).toBe(true)
  })

  it('leaves a session a viewer is still fetching from alone', () => {
    expect(sessionIsIdle(now, { hasPlaylist: true, lastServedAt: now - 1000 }, IDLE_MS)).toBe(false)
    // Exactly at the boundary is not yet idle, so a 2s fetch interval can never race the sweep.
    expect(sessionIsIdle(now, { hasPlaylist: true, lastServedAt: now - IDLE_MS + 1 }, IDLE_MS)).toBe(false)
  })

  it('never reaps a session whose playlist does not exist yet', () => {
    // The client is waiting on POST /api/transcode/start here (up to 45s live, 240s VOD) and
    // cannot be fetching anything; the start path's own deadline owns this case.
    expect(sessionIsIdle(now, { hasPlaylist: false, lastServedAt: now - 10 * IDLE_MS }, IDLE_MS)).toBe(false)
  })

  it('is inert with a non-positive window rather than stopping everything', () => {
    expect(sessionIsIdle(now, { hasPlaylist: true, lastServedAt: 0 }, 0)).toBe(false)
    expect(sessionIsIdle(now, { hasPlaylist: true, lastServedAt: 0 }, Number.NaN)).toBe(false)
  })
})

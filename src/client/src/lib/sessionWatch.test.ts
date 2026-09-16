import { describe, expect, it } from 'vitest'
import { SESSION_WATCH_INTERVAL_MS, sessionExpiredFromStatus } from './sessionWatch'

describe('sessionExpiredFromStatus', () => {
  it('treats a 401 as the session being gone', () => {
    // What a restarted server answers, and what made playback stall with nothing on screen.
    expect(sessionExpiredFromStatus(401)).toBe(true)
  })

  it('treats everything else as still signed in', () => {
    // A blip, a slow request, a 500 — none of them mean "sign in again".
    expect(sessionExpiredFromStatus(200)).toBe(false)
    expect(sessionExpiredFromStatus(204)).toBe(false)
    expect(sessionExpiredFromStatus(500)).toBe(false)
    expect(sessionExpiredFromStatus(0)).toBe(false)
  })

  it('checks often enough to catch a restart quickly, without chattering', () => {
    expect(SESSION_WATCH_INTERVAL_MS).toBeGreaterThanOrEqual(5_000)
    expect(SESSION_WATCH_INTERVAL_MS).toBeLessThanOrEqual(60_000)
  })
})

import { describe, expect, it } from 'vitest'
import {
  DEFAULT_MAX_SESSION_AGE_MS,
  expiredRestoredSessions,
  resolveMaxSessionAgeMs,
  sessionIsExpired
} from './sessionLifetime.js'

const DAY = 24 * 60 * 60 * 1000

describe('resolveMaxSessionAgeMs', () => {
  it('defaults to 30 days when unset, blank, or garbage', () => {
    expect(DEFAULT_MAX_SESSION_AGE_MS).toBe(30 * DAY)
    expect(resolveMaxSessionAgeMs(undefined)).toBe(30 * DAY)
    expect(resolveMaxSessionAgeMs('  ')).toBe(30 * DAY)
    expect(resolveMaxSessionAgeMs('forever')).toBe(30 * DAY)
  })

  it('a zero or negative value is the default too — a typo disables nothing', () => {
    expect(resolveMaxSessionAgeMs('0')).toBe(30 * DAY)
    expect(resolveMaxSessionAgeMs('-12')).toBe(30 * DAY)
  })

  it('reads hours', () => {
    expect(resolveMaxSessionAgeMs('12')).toBe(12 * 60 * 60 * 1000)
    expect(resolveMaxSessionAgeMs(' 168 ')).toBe(7 * DAY)
  })
})

describe('sessionIsExpired', () => {
  it('a session younger than the cap is alive, however active', () => {
    const now = 29 * DAY
    expect(sessionIsExpired(now, { loginAt: 0, lastSeenAt: now }, 30 * DAY)).toBe(false)
  })

  it('a session past the cap ends even though it never went idle — the always-on tab', () => {
    const now = 31 * DAY
    // Heartbeated every moment of its life: lastSeenAt IS now.
    expect(sessionIsExpired(now, { loginAt: 0, lastSeenAt: now }, 30 * DAY)).toBe(true)
  })

  it('the clock is the login, not the last activity — idleness has its own rule', () => {
    const now = 40 * DAY
    expect(sessionIsExpired(now, { loginAt: 0, lastSeenAt: 5 * DAY }, 30 * DAY)).toBe(true)
  })
})

describe('expiredRestoredSessions', () => {
  it('names the rows a restart must not bring back', () => {
    const now = 31 * DAY
    const restored = [
      { tokenHash: 'fresh', session: { loginAt: 29 * DAY, lastSeenAt: now } },
      { tokenHash: 'ancient', session: { loginAt: 0, lastSeenAt: now } }
    ]
    const expired = expiredRestoredSessions(now, restored, 30 * DAY)
    expect(expired.has('ancient')).toBe(true)
    expect(expired.has('fresh')).toBe(false)
  })
})

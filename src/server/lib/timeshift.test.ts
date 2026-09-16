import { describe, expect, it } from 'vitest'
import { buildTimeshiftPath, formatTimeshiftStart, TimeshiftRequestError, TIMESHIFT_MAX_MINUTES } from './timeshift.js'

const creds = { username: 'glustick', password: 'secret' }
const NOW = 1_789_560_000 // 2026-09-16 12:00Z — after every start used below

describe('formatTimeshiftStart', () => {
  it('formats as YYYY-MM-DD:HH-MM in UTC, which is what the provider path expects', () => {
    expect(formatTimeshiftStart(Date.UTC(2026, 8, 16, 3, 5) / 1000)).toBe('2026-09-16:03-05')
    // A minute past midnight must not lose its padding.
    expect(formatTimeshiftStart(Date.UTC(2026, 0, 1, 0, 0) / 1000)).toBe('2026-01-01:00-00')
  })
})

describe('buildTimeshiftPath', () => {
  it('builds the conventional provider path', () => {
    const start = Date.UTC(2026, 8, 16, 1, 30) / 1000
    expect(buildTimeshiftPath(creds, '37421.ts', start, 30, NOW)).toBe(
      '/timeshift/glustick/secret/30/2026-09-16:01-30/37421.ts'
    )
  })

  it('rounds fractional durations rather than emitting decimals in the path', () => {
    const start = Date.UTC(2026, 8, 16, 1, 30) / 1000
    expect(buildTimeshiftPath(creds, '1.ts', start, 29.6, NOW)).toContain('/30/')
  })

  it('percent-encodes credentials that would otherwise reshape the path', () => {
    const start = Date.UTC(2026, 8, 16, 1, 30) / 1000
    const path = buildTimeshiftPath({ username: 'user name', password: 'p@ss/word' }, '7.ts', start, 15, NOW)
    expect(path).toBe('/timeshift/user%20name/p%40ss%2Fword/15/2026-09-16:01-30/7.ts')
  })

  it('refuses a path that is not a channel file', () => {
    for (const bad of ['../../etc/passwd', '37421', '37421.ts?x=1', 'a/b.ts']) {
      expect(() => buildTimeshiftPath(creds, bad, NOW - 600, 30, NOW), bad).toThrow(TimeshiftRequestError)
    }
  })

  it('refuses an implausible start — a typo must not become a request for years of video', () => {
    expect(() => buildTimeshiftPath(creds, '1.ts', 0, 30, NOW)).toThrow(TimeshiftRequestError)
    expect(() => buildTimeshiftPath(creds, '1.ts', NOW + 3600, 30, NOW)).toThrow(TimeshiftRequestError)
    expect(() => buildTimeshiftPath(creds, '1.ts', Number.NaN, 30, NOW)).toThrow(TimeshiftRequestError)
  })

  it('refuses a duration outside the archive bound', () => {
    expect(() => buildTimeshiftPath(creds, '1.ts', NOW - 600, 0, NOW)).toThrow(TimeshiftRequestError)
    expect(() => buildTimeshiftPath(creds, '1.ts', NOW - 600, TIMESHIFT_MAX_MINUTES + 1, NOW)).toThrow(
      TimeshiftRequestError
    )
  })
})

import { describe, it, expect } from 'vitest'
import {
  USABLE_FPS,
  VERDICT_TTL_MS,
  describeVerdict,
  loadVerdict,
  parseVerdict,
  saveVerdict,
  verdictIsUsable,
  type DecodeVerdict
} from './decodeGate'

// The gate exists so a client-side player is only built (and only entered) where the machine has
// proved it can carry one — so these pin the rules that decide "proved", and the tolerance that keeps
// a corrupt value from breaking a panel.

const NOW = Date.parse('2026-09-28T16:00:00Z')

function verdict(partial: Partial<DecodeVerdict> = {}): DecodeVerdict {
  return { measuredAt: NOW - 60_000, framesPerSecond: 240, presentedWidth: 3840, presentedHeight: 2160, codec: 'hev1.1.6.L153.B0', ...partial }
}

describe('verdictIsUsable', () => {
  it('accepts a fresh, fast measurement that produced a picture', () => {
    expect(verdictIsUsable(verdict(), NOW)).toBe(true)
  })

  it('refuses one below realtime — a slideshow with a green tick is the failure this guards', () => {
    expect(verdictIsUsable(verdict({ framesPerSecond: USABLE_FPS - 1 }), NOW)).toBe(false)
    expect(verdictIsUsable(verdict({ framesPerSecond: USABLE_FPS }), NOW)).toBe(true)
  })

  it('refuses a measurement that presented no picture', () => {
    expect(verdictIsUsable(verdict({ presentedWidth: 0, presentedHeight: 0 }), NOW)).toBe(false)
  })

  it('refuses a stale measurement, and nothing at all', () => {
    expect(verdictIsUsable(verdict({ measuredAt: NOW - VERDICT_TTL_MS - 1 }), NOW)).toBe(false)
    expect(verdictIsUsable(null, NOW)).toBe(false)
  })
})

describe('parseVerdict', () => {
  it('round-trips a saved verdict', () => {
    const original = verdict()
    expect(parseVerdict(JSON.stringify(original))).toEqual(original)
  })

  it('treats anything unreadable as "not measured"', () => {
    expect(parseVerdict(null)).toBeNull()
    expect(parseVerdict('{not json')).toBeNull()
    expect(parseVerdict('[]')).toBeNull()
    expect(parseVerdict('{"measuredAt":"yesterday"}')).toBeNull()
    expect(parseVerdict('{"measuredAt":1}')).toBeNull()
  })

  it('fills in a missing picture size rather than inventing one', () => {
    const parsed = parseVerdict('{"measuredAt":1,"framesPerSecond":60}')
    expect(parsed).toEqual({ measuredAt: 1, framesPerSecond: 60, presentedWidth: 0, presentedHeight: 0, codec: '' })
  })
})

describe('describeVerdict', () => {
  it('says what was measured and when', () => {
    expect(describeVerdict(verdict(), NOW)).toBe('240 fps at 3840x2160 — measured 1 min ago')
  })

  it('says so when nothing has been measured', () => {
    expect(describeVerdict(null, NOW)).toMatch(/not measured on this device/)
  })

  it('marks a stale verdict as stale instead of reporting it as current', () => {
    expect(describeVerdict(verdict({ measuredAt: NOW - VERDICT_TTL_MS - 1 }), NOW)).toMatch(/stale, re-run it/)
  })

  it('does not claim a picture when none was presented', () => {
    expect(describeVerdict(verdict({ presentedWidth: 0, presentedHeight: 0 }), NOW)).toMatch(/no picture/)
  })
})

describe('loadVerdict / saveVerdict', () => {
  it('writes and reads back through a storage-like object', () => {
    const store = new Map<string, string>()
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value)
    }
    saveVerdict(verdict(), storage)
    expect(loadVerdict(storage)?.framesPerSecond).toBe(240)
  })

  it('survives storage that throws (private mode)', () => {
    const throwing = {
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => {
        throw new Error('denied')
      }
    }
    expect(loadVerdict(throwing)).toBeNull()
    expect(() => saveVerdict(verdict(), throwing)).not.toThrow()
  })
})

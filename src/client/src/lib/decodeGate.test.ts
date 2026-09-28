import { describe, it, expect } from 'vitest'
import {
  COMFORTABLE_FPS,
  MARGINAL_FPS,
  VERDICT_TTL_MS,
  describeVerdict,
  loadVerdict,
  parseVerdict,
  saveVerdict,
  tierForVerdict,
  verdictIsUsable,
  type DecodeVerdict
} from './decodeGate'

// The gate exists so a client-side player only enters a path the device can actually carry — and,
// after the operator's correction of 2026-09-28, so that a device without hardware acceleration is
// told what it CAN do rather than being written off. These pin the tiers, and the tolerance that
// keeps a corrupt value from breaking a panel.

const NOW = Date.parse('2026-09-28T16:00:00Z')

function verdict(partial: Partial<DecodeVerdict> = {}): DecodeVerdict {
  return { measuredAt: NOW - 60_000, framesPerSecond: 240, presentedWidth: 3840, presentedHeight: 2160, codec: 'hev1.1.6.L153.B0', ...partial }
}

describe('tierForVerdict', () => {
  it('calls a fast decode comfortable — hardware or not, the number is the number', () => {
    expect(tierForVerdict(verdict(), NOW)).toBe('comfortable')
    expect(tierForVerdict(verdict({ framesPerSecond: COMFORTABLE_FPS }), NOW)).toBe('comfortable')
  })

  it('calls a realtime-ish decode marginal rather than unusable', () => {
    // A device decoding at 40 fps on these 50 fps streams drops frames — but a browser that cannot
    // present HEVC any other way is still better off watching than staring at a black screen.
    expect(tierForVerdict(verdict({ framesPerSecond: MARGINAL_FPS }), NOW)).toBe('marginal')
    expect(tierForVerdict(verdict({ framesPerSecond: COMFORTABLE_FPS - 1 }), NOW)).toBe('marginal')
    expect(verdictIsUsable(verdict({ framesPerSecond: MARGINAL_FPS }), NOW)).toBe(true)
  })

  it('calls a slideshow insufficient', () => {
    expect(tierForVerdict(verdict({ framesPerSecond: MARGINAL_FPS - 1 }), NOW)).toBe('insufficient')
    expect(verdictIsUsable(verdict({ framesPerSecond: 4 }), NOW)).toBe(false)
  })

  it('treats no picture as insufficient, whatever the frame count said', () => {
    expect(tierForVerdict(verdict({ presentedWidth: 0, presentedHeight: 0 }), NOW)).toBe('insufficient')
  })

  it('treats a stale measurement as unmeasured — a new GPU can arrive, and so can a driver regression', () => {
    expect(tierForVerdict(verdict({ measuredAt: NOW - VERDICT_TTL_MS - 1 }), NOW)).toBe('insufficient')
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
  it('names the tier, not just the number', () => {
    expect(describeVerdict(verdict(), NOW)).toBe('240 fps at 3840x2160 — measured 1 min ago — comfortable')
  })

  it('is honest about a marginal device', () => {
    expect(describeVerdict(verdict({ framesPerSecond: 42 }), NOW)).toMatch(/marginal — may drop frames/)
  })

  it('says so when nothing has been measured on this device', () => {
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

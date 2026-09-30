import { describe, it, expect } from 'vitest'
import { PTS_HZ, appendPts, choosePresentation, presenterClockPts } from './framePresenter.js'

describe('appendPts', () => {
  it('keeps an ordered stream continuous and unwraps across the 33-bit boundary', () => {
    const first = appendPts(null, 90_000)
    expect(first).toEqual({ pts: 90_000, discontinuity: false })
    expect(appendPts(first.pts, 99_000).discontinuity).toBe(false)
    // Wrapped past 2^33 — the nearest interpretation is one frame on, not 26 hours back.
    const modulus = 2 ** 33
    const beforeWrap = appendPts(modulus - 4_500, modulus - 9_000)
    expect(beforeWrap.discontinuity).toBe(false)
    const afterWrap = appendPts(beforeWrap.pts, 4_500)
    expect(afterWrap.pts).toBe(modulus + 4_500)
    expect(afterWrap.discontinuity).toBe(false)
  })

  it('tolerates B-frame reordering but flags a reset-sized jump in either direction', () => {
    const anchor = appendPts(null, 1_000_000).pts
    // A few frames of reorder: backwards within a second, forwards within ten — both the same timeline.
    expect(appendPts(anchor, anchor + 36_000).discontinuity).toBe(false)
    expect(appendPts(anchor + 36_000, anchor - 18_000).discontinuity).toBe(false)
    expect(appendPts(anchor - 18_000, anchor + 36_000 + 5 * PTS_HZ).discontinuity).toBe(false)
    // Resets: five seconds back, or half a minute forward.
    expect(appendPts(anchor, anchor - 5 * PTS_HZ).discontinuity).toBe(true)
    expect(appendPts(anchor, anchor + 30 * PTS_HZ).discontinuity).toBe(true)
  })
})

describe('presenterClockPts', () => {
  it('advances at 90 kHz from the anchor and never runs backwards', () => {
    const anchorPts = 500_000
    expect(presenterClockPts(anchorPts, 10_000, 10_000)).toBe(anchorPts)
    expect(presenterClockPts(anchorPts, 10_000, 11_000)).toBe(anchorPts + PTS_HZ)
    expect(presenterClockPts(anchorPts, 10_000, 10_250)).toBe(anchorPts + PTS_HZ / 4)
    // A clock tick from before the anchor (scheduler jitter) clamps to the anchor itself.
    expect(presenterClockPts(anchorPts, 10_000, 9_500)).toBe(anchorPts)
  })
})

describe('choosePresentation', () => {
  const frame = (seconds: number): { pts: number } => ({ pts: seconds * PTS_HZ })

  it('presents the newest frame whose time has come, and nothing before its time', () => {
    const frames = [frame(0), frame(0.04), frame(0.08), frame(0.12)]
    expect(choosePresentation(frames, 0.05 * PTS_HZ)).toEqual({ presentIndex: 1, dropUntil: 1 })
    expect(choosePresentation(frames, 0.09 * PTS_HZ)).toEqual({ presentIndex: 2, dropUntil: 2 })
    expect(choosePresentation(frames, -1)).toEqual({ presentIndex: null, dropUntil: 0 })
    expect(choosePresentation([], PTS_HZ)).toEqual({ presentIndex: null, dropUntil: 0 })
  })

  it('drops everything older than the frame being presented — a late decoder skips ahead', () => {
    // Decode stalled, then delivered two seconds at once; the clock has moved past the first nine.
    const frames = Array.from({ length: 12 }, (_, i) => frame(i * 0.04))
    const choice = choosePresentation(frames, 0.4 * PTS_HZ)
    expect(choice.presentIndex).toBe(10)
    expect(choice.dropUntil).toBe(10)
    // Everything before index 10 is late forever — closing it is what keeps 4K frames out of GPU memory.
  })
})

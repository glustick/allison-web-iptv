import { describe, expect, it } from 'vitest'
import { EPG_PAN_SNAP_MS, isTimelineDrag, snapOffset, windowOffsetAfterDrag } from './epgPan'

const WINDOW_MS = 3 * 60 * 60 * 1000
const TRACK_PX = 600

describe('windowOffsetAfterDrag', () => {
  it('slides the window earlier when the timeline is pulled right', () => {
    // 600px shows 3h, so 200px is one hour. Pulling right by 200px should reveal the previous hour.
    expect(windowOffsetAfterDrag(0, 100, 300, TRACK_PX, WINDOW_MS)).toBe(-60 * 60 * 1000)
  })

  it('slides the window later when the timeline is pushed left', () => {
    expect(windowOffsetAfterDrag(0, 300, 100, TRACK_PX, WINDOW_MS)).toBe(60 * 60 * 1000)
  })

  it('keeps a drag relative to the offset it started from', () => {
    const started = -2 * 60 * 60 * 1000
    expect(windowOffsetAfterDrag(started, 0, 50, TRACK_PX, WINDOW_MS)) .toBe(started - 15 * 60 * 1000)
  })

  it('scales with the column width, so a narrow panel still tracks the pointer', () => {
    // Half the width means half the time per pixel: 100px of the 300px track is one hour.
    expect(windowOffsetAfterDrag(0, 0, 100, 300, WINDOW_MS)).toBe(-60 * 60 * 1000)
  })

  it('snaps to quarter hours', () => {
    const result = windowOffsetAfterDrag(0, 0, 10, TRACK_PX, WINDOW_MS)
    expect(result % EPG_PAN_SNAP_MS).toBe(0)
    expect(Math.abs(result)).toBeLessThanOrEqual(EPG_PAN_SNAP_MS)
  })

  it('survives a zero-width track instead of returning NaN or Infinity', () => {
    expect(windowOffsetAfterDrag(1234, 0, 40, 0, WINDOW_MS)).toBe(snapOffset(1234))
    expect(Number.isFinite(windowOffsetAfterDrag(0, 0, 10, Number.NaN, WINDOW_MS))).toBe(true)
  })
})

describe('isTimelineDrag', () => {
  it('needs real movement before a click becomes a pan', () => {
    expect(isTimelineDrag(100, 100, 101, 101)).toBe(false)
    expect(isTimelineDrag(100, 100, 104, 100)).toBe(true)
    expect(isTimelineDrag(100, 100, 96, 100)).toBe(true)
  })

  it('leaves a mostly-vertical drag to the list scrolling it belongs to', () => {
    expect(isTimelineDrag(100, 100, 101, 140)).toBe(false)
    expect(isTimelineDrag(100, 100, 130, 108)).toBe(true)  // diagonal, but horizontal wins
  })
})

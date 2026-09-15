import { describe, expect, it } from 'vitest'
import { EPG_PAN_SNAP_MS, clampScrollOffset, isTimelineDrag, panAxis, snapOffset, windowOffsetAfterDrag } from './epgPan'

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

describe('panAxis', () => {
  it('sends a mostly-horizontal drag to the time window and a mostly-vertical one to the list', () => {
    expect(panAxis(100, 100, 140, 105)).toBe('time')
    expect(panAxis(100, 100, 105, 140)).toBe('list')
  })

  it('ignores movement too small to be a drag', () => {
    expect(panAxis(100, 100, 102, 101)).toBe('none')
    expect(panAxis(100, 100, 100, 100)).toBe('none')
  })

  it('picks one axis for a diagonal drag rather than doing both', () => {
    expect(panAxis(100, 100, 130, 110)).toBe('time')
    expect(panAxis(100, 100, 110, 130)).toBe('list')
  })
})

describe('clampScrollOffset', () => {
  it('keeps a dragged offset inside the list', () => {
    expect(clampScrollOffset(-40, 500)).toBe(0)
    expect(clampScrollOffset(620, 500)).toBe(500)
    expect(clampScrollOffset(200, 500)).toBe(200)
  })

  it('never returns a nonsense offset for a list with nowhere to scroll', () => {
    expect(clampScrollOffset(120, 0)).toBe(0)
    expect(clampScrollOffset(Number.NaN, 500)).toBe(0)
  })
})

describe('isTimelineDrag', () => {
  it('needs real movement before a click becomes a pan', () => {
    expect(isTimelineDrag(100, 100, 101, 101)).toBe(false)
    expect(isTimelineDrag(100, 100, 104, 100)).toBe(true)
    expect(isTimelineDrag(100, 100, 96, 100)).toBe(true)
  })

  it('counts a vertical drag too — that is what moves the channel list', () => {
    expect(isTimelineDrag(100, 100, 101, 140)).toBe(true)
    expect(panAxis(100, 100, 101, 140)).toBe('list')
    expect(isTimelineDrag(100, 100, 130, 108)).toBe(true)  // diagonal, but horizontal wins
  })
})

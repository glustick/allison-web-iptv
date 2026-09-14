import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import {
  MAX_FONT_SCALE,
  percentWidths,
  MIN_FONT_SCALE,
  columnFontScale,
  defaultWidths,
  loadSavedWidths,
  localStorageKey,
  saveWidths,
  totalWidth,
  type ColumnSpec
} from './useResizableColumns'

const columns: ColumnSpec[] = [
  { key: 'user', defaultWidth: 200, min: 100, max: 500 },
  { key: 'role', defaultWidth: 100, min: 60, max: 300 }
]

describe('columnFontScale', () => {
  it('is 1 at the default total width', () => {
    expect(columnFontScale(300, 300)).toBe(1)
  })

  it('follows the drag, growing and shrinking with the columns', () => {
    expect(columnFontScale(360, 300)).toBeCloseTo(1.2, 2)
    expect(columnFontScale(270, 300)).toBeCloseTo(0.9, 2)
  })

  it('clamps so text stays readable and can never run away', () => {
    expect(columnFontScale(3000, 300)).toBe(MAX_FONT_SCALE)
    expect(columnFontScale(30, 300)).toBe(MIN_FONT_SCALE)
  })

  it('falls back to 1 for unusable inputs rather than producing NaN font sizes', () => {
    expect(columnFontScale(Number.NaN, 300)).toBe(1)
    expect(columnFontScale(100, 0)).toBe(1)
  })
})

describe('width bookkeeping', () => {
  it('sums widths and derives defaults from the specs', () => {
    expect(totalWidth({ a: 120, b: 80 })).toBe(200)
    expect(totalWidth({ a: 120, b: Number.NaN })).toBe(120)
    expect(defaultWidths(columns)).toEqual({ user: 200, role: 100 })
  })

  it('expresses widths as proportions that always total 100%', () => {
    // The panels render these, so the table fits whatever the panel width is.
    expect(percentWidths({ a: 200, b: 100 })).toEqual({ a: (200 / 300) * 100, b: (100 / 300) * 100 })
    const widened = percentWidths({ a: 400, b: 100 })
    expect(widened.a).toBeGreaterThan(percentWidths({ a: 200, b: 100 }).a)
    expect(percentWidths({ a: 0, b: 0 })).toEqual({ a: 0, b: 0 })
  })

  it('round-trips saved widths through storage, clamping each one', () => {
    const store = new Map<string, string>()
    const previousWindow = (globalThis as Record<string, unknown>).window
    ;(globalThis as Record<string, unknown>).window = {
      localStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v)
      }
    }
    try {
      saveWidths('t1', { user: 400, role: 50 })
      // 'role' was saved below its minimum, so it comes back clamped, not unusable.
      expect(loadSavedWidths('t1', columns)).toEqual({ user: 400, role: 60 })
      store.set(localStorageKey('t2'), '{not json')
      expect(loadSavedWidths('t2', columns)).toEqual({ user: 200, role: 100 })
      expect(loadSavedWidths('t3', columns)).toEqual({ user: 200, role: 100 })
    } finally {
      ;(globalThis as Record<string, unknown>).window = previousWindow
    }
  })
})

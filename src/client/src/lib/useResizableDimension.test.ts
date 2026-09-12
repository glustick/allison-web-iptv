import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { loadSavedDimension, nextDimension, saveDimension } from './useResizableDimension.js'

describe('nextDimension', () => {
  it('applies the delta unchanged inside the range', () => {
    expect(nextDimension(160, 40, 90, 320)).toBe(200)
    expect(nextDimension(160, -40, 90, 320)).toBe(120)
  })

  it('clamps at both bounds', () => {
    expect(nextDimension(160, 500, 90, 320)).toBe(320)
    expect(nextDimension(160, -500, 90, 320)).toBe(90)
  })

  it('supports a zero delta as a pure re-clamp', () => {
    expect(nextDimension(50, 0, 90, 320)).toBe(90)
    expect(nextDimension(400, 0, 90, 320)).toBe(320)
  })
})

describe('loadSavedDimension / saveDimension', () => {
  // vitest runs this repo's tests in the plain node environment (see vitest.config.mts), so
  // there is no real `window` — the lib is deliberately written to tolerate that (its storage
  // access is guarded), and these tests stand one up to exercise the happy paths.
  let store: Map<string, string>
  const hadWindow = 'window' in globalThis

  function installLocalStorage(access: { getItem(k: string): string | null; setItem(k: string, v: string): void }): void {
    ;(globalThis as Record<string, unknown>).window = { localStorage: access }
  }

  beforeEach(() => {
    store = new Map()
    installLocalStorage({
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => void store.set(k, v)
    })
  })

  afterEach(() => {
    if (!hadWindow) delete (globalThis as Record<string, unknown>).window
  })

  it('returns the fallback when nothing is saved', () => {
    expect(loadSavedDimension('epg-channel-col-width', 160, 90, 320)).toBe(160)
  })

  it('round-trips a saved dimension', () => {
    saveDimension('epg-channel-col-width', 240)
    expect(loadSavedDimension('epg-channel-col-width', 160, 90, 320)).toBe(240)
  })

  it('falls back on non-numeric garbage', () => {
    store.set('sidebar-width', 'not-a-number')
    expect(loadSavedDimension('sidebar-width', 220, 160, 360)).toBe(220)
  })

  it('re-clamps a stale out-of-range value instead of trusting it', () => {
    store.set('player-max-height', '99999')
    expect(loadSavedDimension('player-max-height', 400, 120, 800)).toBe(800)
    store.set('player-max-height', '1')
    expect(loadSavedDimension('player-max-height', 400, 120, 800)).toBe(120)
  })

  it('degrades gracefully when window does not exist at all', () => {
    delete (globalThis as Record<string, unknown>).window
    expect(loadSavedDimension('any', 160, 90, 320)).toBe(160)
    expect(() => saveDimension('any', 200)).not.toThrow()
  })

  it('degrades gracefully when localStorage access throws', () => {
    installLocalStorage({
      getItem: () => {
        throw new Error('SecurityError')
      },
      setItem: () => {
        throw new Error('SecurityError')
      }
    })
    expect(loadSavedDimension('any', 160, 90, 320)).toBe(160)
    expect(() => saveDimension('any', 200)).not.toThrow()
  })
})

describe('useResizableDimension module surface', () => {
  it('re-clamps via the shared pure helper', () => {
    expect(nextDimension(220, 0, 160, 360)).toBe(220)
  })
})

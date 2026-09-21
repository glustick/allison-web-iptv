import { describe, it, expect } from 'vitest'
import { NATIVE_HLS_MIME, prefersNativePlayback } from './nativePlayback.js'

describe('prefersNativePlayback', () => {
  it('says yes when the browser offers its own HLS pipeline', () => {
    const asked: string[] = []
    const canPlayType = (type: string): string => {
      asked.push(type)
      return 'maybe'
    }
    expect(prefersNativePlayback(canPlayType)).toBe(true)
    expect(asked).toEqual([NATIVE_HLS_MIME])
  })

  it('says no for a browser whose native player cannot play HLS at all (Chromium)', () => {
    expect(prefersNativePlayback(() => '')).toBe(false)
  })

  it('says no when the question itself fails', () => {
    expect(
      prefersNativePlayback(() => {
        throw new Error('not supported here')
      })
    ).toBe(false)
  })
})

import { describe, expect, it } from 'vitest'
import { clearNotBroadcasting, rememberNotBroadcasting, wasRecentlyNotBroadcasting } from './offAirHints.js'

function fakeStorage(): Pick<Storage, 'getItem' | 'setItem'> {
  const store = new Map<string, string>()
  return {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => void store.set(key, value)
  }
}

describe('offAirHints', () => {
  it('remembers and answers a fresh declaration', () => {
    const storage = fakeStorage()
    rememberNotBroadcasting('/api/stream/live/668.m3u8', 1000, storage)
    expect(wasRecentlyNotBroadcasting('/api/stream/live/668.m3u8', 2000, storage)).toBe(true)
  })

  it('a declaration past the TTL stops shaping attempts', () => {
    const storage = fakeStorage()
    rememberNotBroadcasting('/api/stream/live/668.m3u8', 1000, storage)
    expect(wasRecentlyNotBroadcasting('/api/stream/live/668.m3u8', 1000 + 10 * 60 * 1000 + 1, storage)).toBe(false)
  })

  it('fragments flowing again clears the hint — the probe proved the channel alive', () => {
    const storage = fakeStorage()
    rememberNotBroadcasting('/api/stream/live/668.m3u8', 1000, storage)
    clearNotBroadcasting('/api/stream/live/668.m3u8', storage)
    expect(wasRecentlyNotBroadcasting('/api/stream/live/668.m3u8', 1001, storage)).toBe(false)
  })
})

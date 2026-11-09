import { describe, expect, it } from 'vitest'
import { isWatched, watchedKey } from './watchState'
import type { WatchedEntry } from './prefs'

const entry = (overrides: Partial<WatchedEntry> & { streamId: number }): WatchedEntry => ({
  kind: 'movie',
  name: 'A Title',
  category: null,
  watchedAt: '2026-11-09T00:00:00.000Z',
  ...overrides
})

describe('watchedKey', () => {
  it('separates the two kinds and the two playlists', () => {
    expect(watchedKey({ kind: 'movie', streamId: 7 })).toBe('movie::7')
    expect(watchedKey({ kind: 'movie', playlistId: '', streamId: 7 })).toBe('movie::7')
    expect(watchedKey({ kind: 'movie', playlistId: 'primary', streamId: 7 })).toBe('movie:primary:7')
    expect(watchedKey({ kind: 'series', streamId: 7 })).toBe('series::7')
  })
})

describe('isWatched', () => {
  it('matches an absent playlist to the empty one — the same title, however it was stored', () => {
    const list = [entry({ streamId: 7, playlistId: '' })]
    expect(isWatched(list, { kind: 'movie', streamId: 7 })).toBe(true)
    expect(isWatched(list, { kind: 'movie', playlistId: 'primary', streamId: 7 })).toBe(false)
  })

  it('does not confuse the same id across kinds', () => {
    const list = [entry({ streamId: 7, kind: 'series' })]
    expect(isWatched(list, { kind: 'movie', streamId: 7 })).toBe(false)
    expect(isWatched(list, { kind: 'series', streamId: 7 })).toBe(true)
  })

  it('is false for an empty list', () => {
    expect(isWatched([], { kind: 'movie', streamId: 7 })).toBe(false)
  })
})

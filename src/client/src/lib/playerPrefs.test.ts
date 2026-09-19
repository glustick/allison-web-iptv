import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PLAYER_PREFS,
  loadPlayerPrefs,
  pickTrackIndex,
  savePlayerPrefs,
  trackKey
} from './playerPrefs'
import type { PlayerTrack } from '../components/TrackControls'

function track(index: number, lang: string | null, name = ''): PlayerTrack {
  return { index, name, lang, default: false } as PlayerTrack
}

function fakeStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial))
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    dump: () => Object.fromEntries(map)
  }
}

describe('player preferences', () => {
  it('round-trips a choice', () => {
    const storage = fakeStorage()
    savePlayerPrefs({ audioTrack: 'eng', subtitleTrack: 'swe', subtitlesOff: false }, storage)
    expect(loadPlayerPrefs(storage)).toEqual({ audioTrack: 'eng', subtitleTrack: 'swe', subtitlesOff: false })
  })

  it('remembers that subtitles were switched off — that is a choice too', () => {
    const storage = fakeStorage()
    savePlayerPrefs({ audioTrack: 'eng', subtitleTrack: null, subtitlesOff: true }, storage)
    expect(loadPlayerPrefs(storage).subtitlesOff).toBe(true)
  })

  it('falls back to the defaults when storage is empty, rubbish, or unavailable', () => {
    expect(loadPlayerPrefs(fakeStorage())).toEqual(DEFAULT_PLAYER_PREFS)
    expect(loadPlayerPrefs(fakeStorage({ 'iptv:player-prefs': 'not json' }))).toEqual(DEFAULT_PLAYER_PREFS)
    expect(loadPlayerPrefs(null)).toEqual(DEFAULT_PLAYER_PREFS)
  })

  it('does not throw when storage refuses to write', () => {
    const hostile = { setItem: () => { throw new Error('full') } }
    expect(() => savePlayerPrefs(DEFAULT_PLAYER_PREFS, hostile)).not.toThrow()
  })
})

describe('picking a track for a saved preference', () => {
  const tracks = [track(0, 'eng', 'English'), track(1, 'swe'), track(2, null, 'Commentary')]

  it('identifies a track by language, falling back to its name', () => {
    expect(trackKey(tracks[0])).toBe('eng')
    expect(trackKey(tracks[2])).toBe('Commentary')
  })

  it('finds the saved language', () => {
    expect(pickTrackIndex(tracks, 'swe')).toBe(1)
    expect(pickTrackIndex(tracks, 'Commentary')).toBe(2)
  })

  it('returns nothing when this stream has no such track, so its own default stands', () => {
    expect(pickTrackIndex(tracks, 'fra')).toBeNull()
    expect(pickTrackIndex(tracks, null)).toBeNull()
  })
})

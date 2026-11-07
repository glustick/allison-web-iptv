import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PLAYER_PREFS,
  loadPlayerPrefs,
  pickTrackIndex,
  savePlayerPrefs,
  trackKey,
  type PlayerPrefs
} from './playerPrefs'
import { DEFAULT_SUBTITLE_STYLE } from './subtitleStyle'
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

/** The defaults, with only the field a test cares about replaced. */
function prefs(overrides: Partial<PlayerPrefs> = {}): PlayerPrefs {
  return { ...DEFAULT_PLAYER_PREFS, ...overrides }
}

describe('player preferences', () => {
  it('round-trips a choice', () => {
    const storage = fakeStorage()
    const chosen = prefs({ audioTrack: 'eng', subtitleTrack: 'swe' })
    savePlayerPrefs(chosen, storage)
    expect(loadPlayerPrefs(storage)).toEqual(chosen)
  })

  it('remembers that subtitles were switched off — that is a choice too', () => {
    const storage = fakeStorage()
    savePlayerPrefs(prefs({ audioTrack: 'eng', subtitlesOff: true }), storage)
    expect(loadPlayerPrefs(storage).subtitlesOff).toBe(true)
  })

  it('round-trips the quality ceiling, and refuses out-of-range values', () => {
    const storage = fakeStorage()
    savePlayerPrefs(prefs({ maxHeight: 720 }), storage)
    expect(loadPlayerPrefs(storage).maxHeight).toBe(720)
    // A hand-edited or stale out-of-range value reads as Source, never as a broken encode.
    savePlayerPrefs(prefs({ maxHeight: 99999 }), storage)
    expect(loadPlayerPrefs(storage).maxHeight).toBeNull()
    savePlayerPrefs(prefs({ maxHeight: '720' as unknown as number }), storage)
    expect(loadPlayerPrefs(storage).maxHeight).toBeNull()
  })

  it('round-trips the subtitle style', () => {
    const storage = fakeStorage()
    const subtitleStyle = { sizePercent: 150, color: 'yellow' as const, backgroundOpacity: 85, outline: false }
    savePlayerPrefs(prefs({ subtitleStyle }), storage)
    expect(loadPlayerPrefs(storage).subtitleStyle).toEqual(subtitleStyle)
  })

  it('round-trips volume, mute and playback speed, refusing nonsense', () => {
    const storage = fakeStorage()
    savePlayerPrefs(prefs({ volume: 0.35, muted: true, playbackRate: 1.25 }), storage)
    expect(loadPlayerPrefs(storage)).toEqual(prefs({ volume: 0.35, muted: true, playbackRate: 1.25 }))
    savePlayerPrefs(prefs({ volume: 4, playbackRate: 3 }), storage)
    expect(loadPlayerPrefs(storage).volume).toBeNull()
    expect(loadPlayerPrefs(storage).playbackRate).toBe(1)
  })

  it('gives pre-0.89 storage — which has no subtitle style at all — the default rather than a crash', () => {
    // The exact shape v0.88.0 wrote: four fields, no subtitleStyle key.
    const storage = fakeStorage({
      'iptv:player-prefs': JSON.stringify({ audioTrack: 'eng', subtitleTrack: null, subtitlesOff: false, maxHeight: 1080 })
    })
    expect(loadPlayerPrefs(storage)).toEqual(prefs({ audioTrack: 'eng', maxHeight: 1080 }))
    expect(loadPlayerPrefs(storage).subtitleStyle).toEqual(DEFAULT_SUBTITLE_STYLE)
  })

  it('clamps a hand-edited subtitle style rather than trusting it', () => {
    const storage = fakeStorage({
      'iptv:player-prefs': JSON.stringify({
        ...DEFAULT_PLAYER_PREFS,
        subtitleStyle: { sizePercent: 9000, color: 'chartreuse', backgroundOpacity: -4, outline: 'yes' }
      })
    })
    const style = loadPlayerPrefs(storage).subtitleStyle
    expect(style.sizePercent).toBe(200)
    expect(style.color).toBe('white')
    expect(style.backgroundOpacity).toBe(0)
    // Only an explicit `false` turns the outline off.
    expect(style.outline).toBe(true)
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

/**
 * Remember the viewer's audio and subtitle choice.
 *
 * Deliberately **per device** (`localStorage`), not per account, and for the same reason the transcode
 * memory is: which track is the right one depends on what *this browser* can decode. Safari wants a
 * different audio track from Chrome on the same channel, so a choice synced across devices would be
 * wrong on at least one of them.
 *
 * Tracks are remembered by **language** (falling back to the track's name), never by index: this
 * provider renumbers things, and an index that meant "the AAC track" last week is not guaranteed to
 * mean it today.
 */
import type { PlayerTrack } from '../components/TrackControls'

const KEY = 'iptv:player-prefs'

export interface PlayerPrefs {
  /** A track's language code, or its name when the provider gives no language. */
  audioTrack: string | null
  subtitleTrack: string | null
  /** Subtitles explicitly turned off, which is a choice and must survive too. */
  subtitlesOff: boolean
}

export const DEFAULT_PLAYER_PREFS: PlayerPrefs = { audioTrack: null, subtitleTrack: null, subtitlesOff: false }

export function loadPlayerPrefs(storage: Pick<Storage, 'getItem'> | null = safeStorage()): PlayerPrefs {
  if (!storage) return DEFAULT_PLAYER_PREFS
  try {
    const raw = storage.getItem(KEY)
    if (!raw) return DEFAULT_PLAYER_PREFS
    const parsed = JSON.parse(raw) as Partial<PlayerPrefs>
    return {
      audioTrack: typeof parsed.audioTrack === 'string' ? parsed.audioTrack : null,
      subtitleTrack: typeof parsed.subtitleTrack === 'string' ? parsed.subtitleTrack : null,
      subtitlesOff: parsed.subtitlesOff === true
    }
  } catch {
    return DEFAULT_PLAYER_PREFS
  }
}

export function savePlayerPrefs(
  prefs: PlayerPrefs,
  storage: Pick<Storage, 'setItem'> | null = safeStorage()
): void {
  if (!storage) return
  try {
    storage.setItem(KEY, JSON.stringify(prefs))
  } catch {
    // A full or unavailable store is not worth failing playback over.
  }
}

/** How a track is identified in storage: its language, else its name. */
export function trackKey(track: PlayerTrack): string {
  const lang = (track.lang ?? '').trim()
  return lang || (track.name ?? '').trim()
}

/**
 * The index of the track matching a saved preference, or null when this stream has no such track —
 * a channel that simply does not carry that language should keep its own default.
 */
export function pickTrackIndex(tracks: PlayerTrack[], wanted: string | null): number | null {
  if (!wanted) return null
  const match = tracks.find((track) => trackKey(track) === wanted)
  return match ? match.index : null
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

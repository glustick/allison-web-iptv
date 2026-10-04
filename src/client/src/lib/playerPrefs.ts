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
  /**
   * The viewer's quality ceiling for channels this browser can only play through the server's
   * video re-encode (v0.75.0): null means Source — the picture the provider sent — and a number
   * (1080, 720) caps the re-encode's height so a host that cannot keep up at full resolution
   * gets one the viewer chose deliberately. Per device, like the track choices: it is a
   * statement about *this* machine's playback, and the re-encode a channel needs is itself
   * per browser. Applies only to the re-encode tier — native playback and the copy tier are
   * untouched, and a copy cannot reshape anything anyway.
   */
  maxHeight: number | null
}

export const DEFAULT_PLAYER_PREFS: PlayerPrefs = {
  audioTrack: null,
  subtitleTrack: null,
  subtitlesOff: false,
  maxHeight: null
}

export function loadPlayerPrefs(storage: Pick<Storage, 'getItem'> | null = safeStorage()): PlayerPrefs {
  if (!storage) return DEFAULT_PLAYER_PREFS
  try {
    const raw = storage.getItem(KEY)
    if (!raw) return DEFAULT_PLAYER_PREFS
    const parsed = JSON.parse(raw) as Partial<PlayerPrefs>
    return {
      audioTrack: typeof parsed.audioTrack === 'string' ? parsed.audioTrack : null,
      subtitleTrack: typeof parsed.subtitleTrack === 'string' ? parsed.subtitleTrack : null,
      subtitlesOff: parsed.subtitlesOff === true,
      maxHeight:
        typeof parsed.maxHeight === 'number' && Number.isFinite(parsed.maxHeight) && parsed.maxHeight >= 240 && parsed.maxHeight <= 2160
          ? parsed.maxHeight
          : null
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

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
import { DEFAULT_SUBTITLE_STYLE, normalizeSubtitleStyle, type SubtitleStyle } from './subtitleStyle'

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
  /**
   * How the cues themselves look (v0.89.0): size, text colour, the box behind the text, and
   * whether the glyphs carry an outline. Per device for the same reason the quality ceiling is —
   * a phone held at arm's length and a projector across a room do not want the same cue size —
   * and it is a preference about the *viewer*, not about the account, so it never syncs.
   */
  subtitleStyle: SubtitleStyle
  /**
   * Volume the viewer set, 0–1, or null to leave the element's own default (v0.93.0). Restoring a
   * volume is safe; restoring *mute* before playback would make browsers refuse an unmuted
   * autoplay, so `muted` is applied on the first `playing` event instead (see usePlaybackPrefs).
   */
  volume: number | null
  muted: boolean
  /** Films and episodes only — live has no meaningful speed (v0.93.0). */
  playbackRate: number
}

/** The speeds the player offers; anything else read from storage falls back to 1. */
export const PLAYBACK_RATES = [0.75, 1, 1.25, 1.5] as const

export const DEFAULT_PLAYER_PREFS: PlayerPrefs = {
  audioTrack: null,
  subtitleTrack: null,
  subtitlesOff: false,
  maxHeight: null,
  subtitleStyle: DEFAULT_SUBTITLE_STYLE,
  volume: null,
  muted: false,
  playbackRate: 1
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
          : null,
      subtitleStyle: normalizeSubtitleStyle(parsed.subtitleStyle),
      volume:
        typeof parsed.volume === 'number' && Number.isFinite(parsed.volume) && parsed.volume >= 0 && parsed.volume <= 1
          ? parsed.volume
          : null,
      muted: parsed.muted === true,
      playbackRate:
        typeof parsed.playbackRate === 'number' && (PLAYBACK_RATES as readonly number[]).includes(parsed.playbackRate)
          ? parsed.playbackRate
          : 1
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

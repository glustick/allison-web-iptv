// Remembering that a stream needs the transcoder, so the futile direct attempt stops happening every
// time. Measured reality: Sky News FHD carries E-AC-3 first (undecodable in Chrome) and Batman Begins
// is E-AC-3 5.1 inside Matroska — both play nothing for 10-30 seconds before the fallback notices and
// starts converting. Once a stream has needed it, it will need it again.
//
// Deliberately client-side and per-device: it is a playback optimisation, not shared state, and it
// costs nothing to relearn on a new device. Bounded and time-limited, because a stream can be
// re-encoded upstream and stop needing this — a stale hint would then force a pointless transcode.
const STORAGE_KEY = 'iptv:transcode-hints'

/** How long a hint is trusted. Long enough to be useful, short enough to recover from a fix. */
export const TRANSCODE_HINT_TTL_MS = 14 * 24 * 60 * 60 * 1000

/** Bounded so a long-lived browser cannot accumulate entries for ever. */
export const TRANSCODE_HINT_LIMIT = 200

export interface TranscodeHint {
  url: string
  at: number
  // Set once a plain stream-copy session proved undecodable on this device, so the next play
  // starts the video re-encode tier directly instead of paying for a copy session it will have to
  // abandon. Absent (the common case) means "needs converting" alone.
  video?: boolean
}

/** Keeps entries that are well-formed and fresh, newest first, capped. */
export function pruneHints(raw: unknown, now: number, ttlMs = TRANSCODE_HINT_TTL_MS): TranscodeHint[] {
  if (!Array.isArray(raw)) return []
  const kept: TranscodeHint[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const { url, at, video } = entry as Partial<TranscodeHint>
    if (typeof url !== 'string' || !url || typeof at !== 'number' || !Number.isFinite(at)) continue
    if (now - at > ttlMs || at > now) continue
    kept.push(video === true ? { url, at, video: true } : { url, at })
  }
  return kept.sort((a, b) => b.at - a.at).slice(0, TRANSCODE_HINT_LIMIT)
}

export function hasHint(hints: readonly TranscodeHint[], url: string): boolean {
  return hints.some((hint) => hint.url === url)
}

/**
 * Adds or refreshes a hint, keeping the list bounded and newest-first. `video` is tri-state: true
 * records the video re-encode requirement, false clears it, and undefined leaves whatever the
 * existing entry carried — so an ordinary audio-only fallback never silently downgrades a channel
 * that genuinely needs H.264.
 */
export function rememberHint(
  hints: readonly TranscodeHint[],
  url: string,
  now: number,
  video?: boolean
): TranscodeHint[] {
  if (!url) return [...hints]
  const existing = hints.find((hint) => hint.url === url)
  const keepVideo = video ?? existing?.video ?? false
  return [
    { url, at: now, ...(keepVideo ? { video: true } : {}) },
    ...hints.filter((hint) => hint.url !== url)
  ].slice(0, TRANSCODE_HINT_LIMIT)
}

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    // Private mode, storage disabled — a playback optimisation is never worth failing a render over.
    return null
  }
}

export function loadHints(now = Date.now()): TranscodeHint[] {
  const store = storage()
  if (!store) return []
  try {
    return pruneHints(JSON.parse(store.getItem(STORAGE_KEY) ?? '[]'), now)
  } catch {
    return []
  }
}

export function saveHints(hints: readonly TranscodeHint[]): void {
  const store = storage()
  if (!store) return
  try {
    store.setItem(STORAGE_KEY, JSON.stringify(hints))
  } catch {
    /* see storage() */
  }
}

/** The calls a player needs: does this stream already need converting (and how deeply), and note it. */
export function streamNeedsTranscode(url: string, now = Date.now()): boolean {
  return hasHint(loadHints(now), url)
}

/** Whether this stream previously needed the video re-encode tier, not just the audio remux. */
export function streamNeedsVideoTranscode(url: string, now = Date.now()): boolean {
  return loadHints(now).find((hint) => hint.url === url)?.video === true
}

export function noteStreamNeedsTranscode(url: string, now = Date.now(), video?: boolean): void {
  saveHints(rememberHint(loadHints(now), url, now, video))
}

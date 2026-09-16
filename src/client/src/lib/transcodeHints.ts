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
}

/** Keeps entries that are well-formed and fresh, newest first, capped. */
export function pruneHints(raw: unknown, now: number, ttlMs = TRANSCODE_HINT_TTL_MS): TranscodeHint[] {
  if (!Array.isArray(raw)) return []
  const kept: TranscodeHint[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const { url, at } = entry as Partial<TranscodeHint>
    if (typeof url !== 'string' || !url || typeof at !== 'number' || !Number.isFinite(at)) continue
    if (now - at > ttlMs || at > now) continue
    kept.push({ url, at })
  }
  return kept.sort((a, b) => b.at - a.at).slice(0, TRANSCODE_HINT_LIMIT)
}

export function hasHint(hints: readonly TranscodeHint[], url: string): boolean {
  return hints.some((hint) => hint.url === url)
}

/** Adds or refreshes a hint, keeping the list bounded and newest-first. */
export function rememberHint(
  hints: readonly TranscodeHint[],
  url: string,
  now: number
): TranscodeHint[] {
  if (!url) return [...hints]
  return [{ url, at: now }, ...hints.filter((hint) => hint.url !== url)].slice(0, TRANSCODE_HINT_LIMIT)
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

/** The two calls a player needs: does this stream already need converting, and note that it does. */
export function streamNeedsTranscode(url: string, now = Date.now()): boolean {
  return hasHint(loadHints(now), url)
}

export function noteStreamNeedsTranscode(url: string, now = Date.now()): void {
  saveHints(rememberHint(loadHints(now), url, now))
}

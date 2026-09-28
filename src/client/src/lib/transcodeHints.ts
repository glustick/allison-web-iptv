// Remembering that a stream needs the transcoder, so the futile direct attempt stops happening every
// time. Measured reality: Sky News FHD carries E-AC-3 first (undecodable in Chrome) and Batman Begins
// is E-AC-3 5.1 inside Matroska — both play nothing for 10-30 seconds before the fallback notices and
// starts converting. Once a stream has needed it, it will need it again.
//
// Bounded and time-limited, because a stream can be re-encoded upstream and stop needing this — a
// stale hint would then force a pointless transcode. A *failure* is dropped outright, on both sides:
// a plan that failed is a plan to re-discover.
//
// **Where the record lives.** It began as localStorage, deliberately per device; the operator asked
// for better on 2026-09-28 — *"a persistent record for each channel's transcoding need … a database
// should be reference for the last known working config … persistent through different builds"*. The
// record now lives on the server (`channel_plans`, in the app's database, shared by every device and
// surviving image updates). This module keeps the same API the player already calls, and stays what
// is read **synchronously** on the playback path — a hint that cost a round trip would defeat its own
// purpose — as an in-memory mirror refreshed once a session by syncChannelPlans(), with localStorage
// as the instant-boot copy and the offline fallback.
const STORAGE_KEY = 'iptv:transcode-hints'

/** How long a hint is trusted. Matches the server's own window (lib/channelPlans.ts), so a plan the
 *  server still trusts is never discarded by the mirror. */
export const TRANSCODE_HINT_TTL_MS = 30 * 24 * 60 * 60 * 1000

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

// The in-memory mirror: read synchronously on the playback path, refreshed once a session.
let cache: TranscodeHint[] | null = null

function readCache(now: number = Date.now()): TranscodeHint[] {
  if (cache) return pruneHints(cache, now)
  const store = storage()
  if (!store) {
    cache = []
    return cache
  }
  try {
    cache = pruneHints(JSON.parse(store.getItem(STORAGE_KEY) ?? '[]'), now)
  } catch {
    cache = []
  }
  return cache
}

function writeCache(hints: TranscodeHint[]): void {
  cache = hints
  const store = storage()
  if (!store) return
  try {
    store.setItem(STORAGE_KEY, JSON.stringify(hints))
  } catch {
    /* see storage() */
  }
}

export function loadHints(now = Date.now()): TranscodeHint[] {
  return readCache(now)
}

export function saveHints(hints: readonly TranscodeHint[]): void {
  writeCache([...hints])
}

/** The calls a player needs: does this stream already need converting (and how deeply), and note it. */
export function streamNeedsTranscode(url: string, now = Date.now()): boolean {
  return hasHint(readCache(now), url)
}

/** Whether this stream previously needed the video re-encode tier, not just the audio remux. */
export function streamNeedsVideoTranscode(url: string, now = Date.now()): boolean {
  return readCache(now).find((hint) => hint.url === url)?.video === true
}

export function noteStreamNeedsTranscode(url: string, now = Date.now(), video?: boolean): void {
  const hints = rememberHint(readCache(now), url, now, video)
  writeCache(hints)
  const hint = hints.find((entry) => entry.url === url)
  if (!hint) return
  // Written from a playback that worked — never from an attempt (see the server store's own note).
  void fetch('/api/channels/plans', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: url, video: hint.video === true, audio: true, note: 'proved by playback' })
  }).catch(() => {
    // Offline, or the session lapsed: the local mirror still carries the hint.
  })
}

// --- the server record -------------------------------------------------------------------------

/**
 * Pulls the household's channel plans and mirrors them locally. Called once a session is up, so the
 * playback path never pays for it; the fetch is deliberately fire-and-forget.
 */
export async function syncChannelPlans(): Promise<void> {
  try {
    const res = await fetch('/api/channels/plans')
    if (!res.ok) return
    const data = (await res.json()) as {
      plans?: Array<{ key?: unknown; video?: unknown; verifiedAt?: unknown; failures?: unknown }>
    }
    const now = Date.now()
    const fromServer: TranscodeHint[] = []
    for (const plan of Array.isArray(data.plans) ? data.plans : []) {
      if (typeof plan?.key !== 'string' || plan.key.length === 0) continue
      // A plan that has failed is not carried over: the server drops it too, and a mirror must not
      // resurrect an answer that has just been proved wrong.
      if (plan.failures !== 0) continue
      const at = typeof plan.verifiedAt === 'number' ? plan.verifiedAt : now
      fromServer.push(plan.video === true ? { url: plan.key, at, video: true } : { url: plan.key, at })
    }
    // The server wins for every channel it knows; local entries it has not seen yet (a plan being
    // proved right now, or a write that has not landed) are kept rather than discarded.
    const known = new Set(fromServer.map((hint) => hint.url))
    const localOnly = readCache(now).filter((hint) => !known.has(hint.url))
    writeCache(pruneHints([...fromServer, ...localOnly], now))
  } catch {
    // Offline, or signed out: the local mirror stands.
  }
}

/**
 * A plan that failed is a plan to re-discover: tell the server (which forgets it) and drop the local
 * copy, so the next click pays for discovery once rather than repeating a wrong answer for a month.
 */
export function reportChannelPlanFailed(url: string, reason: string): void {
  writeCache(readCache().filter((hint) => hint.url !== url))
  void fetch('/api/channels/plans/failed', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: url, reason })
  }).catch(() => {})
}

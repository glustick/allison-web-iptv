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

/**
 * Fire-and-forget reporting. Guarded because this module is imported by code that also runs outside a
 * browser (tests, SSR-ish tooling), where `fetch` does not exist — and a missing transport must never
 * turn a playback optimisation into a thrown exception.
 */
function postJson(path: string, body: unknown): void {
  try {
    if (typeof fetch !== 'function') return
    void fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).catch(() => {
      // Offline, or the session lapsed: the local mirror still carries the answer.
    })
  } catch {
    // See above.
  }
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

/**
 * One line for the diagnostics panel: what this channel was last proved to need, and when.
 *
 * The record exists to stop the app re-discovering a channel on every click (the operator's ask,
 * 2026-09-28) — so it should also be *visible*, or the only evidence it works is that a channel
 * started faster than it used to.
 */
export function describeChannelPlan(url: string, now = Date.now()): string {
  const age = (at: number): string => {
    const ms = Math.max(0, now - at)
    return ms < 3_600_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 3_600_000)} h`
  }
  // A channel that needed converting is the more useful statement, so it wins over a direct play: the
  // two can both be true if the audio was undecodable and the fallback fixed it.
  const hint = readCache(now).find((entry) => entry.url === url)
  if (hint) {
    const parts = [hint.video === true ? 'video re-encode' : 'video copy', 'audio re-encode']
    return `${parts.join(', ')} — proved ${age(hint.at)} ago`
  }
  const direct = directPlays.get(url)
  if (direct !== undefined) return `direct play, no conversion needed — proved ${age(direct)} ago`
  return 'unknown — this channel has not been proved yet'
}

// --- probed codecs ----------------------------------------------------------------------------
// What a channel's stream *carries*, as opposed to what it needed. Kept apart from the plan above
// because it is a fact rather than a bet — and because a fresh page load consults it before spending
// an ffprobe against a live source, which is the round trip the operator asked to stop paying.

/** Matches the server's own window (lib/channelPlans.ts): providers swap feeds. */
export const TRACKS_TTL_MS = 7 * 24 * 60 * 60 * 1000

export interface RememberedStreamFacts {
  videoCodec: string | null
  audioCodecs: string[]
}

const tracks = new Map<string, RememberedStreamFacts & { at: number }>()

/**
 * Channels that have played **directly** — no conversion — and when.
 *
 * Kept apart from the hint list above on purpose: an entry there means "needs converting", so writing
 * a success into it would force the very transcode the channel does not need. This is the other half
 * of the operator's original ask (2026-09-28) — *"a database should be reference for the last known
 * working config"* — and until now only failures were recorded, so a channel that simply worked read
 * as "unknown".
 */
const directPlays = new Map<string, number>()

/** Records that this channel played directly, on both sides. */
export function noteStreamPlaysDirectly(url: string, now = Date.now()): void {
  directPlays.set(url, now)
  postJson('/api/channels/plans', { key: url, video: false, audio: false, note: 'played directly' })
}

/** The codecs this channel was last probed for, or null when unknown or stale. */
export function rememberedTracks(url: string, now = Date.now()): RememberedStreamFacts | null {
  const entry = tracks.get(url)
  if (!entry) return null
  if (now - entry.at > TRACKS_TTL_MS) return null
  if (!entry.videoCodec && entry.audioCodecs.length === 0) return null
  return { videoCodec: entry.videoCodec, audioCodecs: entry.audioCodecs }
}

/** Records a probe's answer locally and on the server, so the next session does not ask again. */
export function rememberStreamFacts(url: string, facts: RememberedStreamFacts): void {
  tracks.set(url, { videoCodec: facts.videoCodec, audioCodecs: [...facts.audioCodecs], at: Date.now() })
  postJson('/api/channels/plans/facts', { key: url, videoCodec: facts.videoCodec, audioCodecs: facts.audioCodecs })
}

/** Drops every remembered probe answer. The app never needs this; tests and a sign-out do. */
export function forgetRememberedTracks(): void {
  tracks.clear()
}

/** The same for the direct-play records — module state, so tests have to be able to reset it. */
export function forgetDirectPlays(): void {
  directPlays.clear()
}

export function noteStreamNeedsTranscode(url: string, now = Date.now(), video?: boolean): void {
  const hints = rememberHint(readCache(now), url, now, video)
  writeCache(hints)
  const hint = hints.find((entry) => entry.url === url)
  if (!hint) return
  // Written from a playback that worked — never from an attempt (see the server store's own note).
  postJson('/api/channels/plans', { key: url, video: hint.video === true, audio: true, note: 'proved by playback' })
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
      plans?: Array<{
        key?: unknown
        video?: unknown
        audio?: unknown
        verifiedAt?: unknown
        failures?: unknown
        proved?: unknown
        videoCodec?: unknown
        audioCodecs?: unknown
        factsAt?: unknown
      }>
    }
    const now = Date.now()
    const fromServer: TranscodeHint[] = []
    for (const plan of Array.isArray(data.plans) ? data.plans : []) {
      if (typeof plan?.key !== 'string' || plan.key.length === 0) continue
      // Codecs ride on the same rows, proved or not — a channel nobody has played yet can still have
      // been probed, and that is exactly the round trip worth saving.
      const codecs = Array.isArray(plan.audioCodecs)
        ? plan.audioCodecs.filter((codec): codec is string => typeof codec === 'string')
        : []
      if (typeof plan.videoCodec === 'string' || codecs.length > 0) {
        tracks.set(plan.key, {
          videoCodec: typeof plan.videoCodec === 'string' ? plan.videoCodec : null,
          audioCodecs: codecs,
          at: typeof plan.factsAt === 'number' ? plan.factsAt : now
        })
      }
      // A plan that has failed is not carried over: the server drops it too, and a mirror must not
      // resurrect an answer that has just been proved wrong.
      if (plan.failures !== 0) continue
      if (plan.proved !== true) continue
      const at = typeof plan.verifiedAt === 'number' ? plan.verifiedAt : now
      // A proved plan with no flags is a **direct play** — nothing needed converting — and it is worth
      // as much as a conversion is, just in the other direction.
      if (plan.video !== true && plan.audio !== true) {
        directPlays.set(plan.key, at)
        continue
      }
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
  // Including a recorded direct play: this channel did *not* in fact work, whatever an earlier run saw.
  directPlays.delete(url)
  postJson('/api/channels/plans/failed', { key: url, reason })
}

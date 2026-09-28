// The per-device verdict from the client-side decode check — the gate a client-side player consults.
//
// The roadmap's own order (2026-09-22) puts a measurement before the player, and for a reason worth
// restating: `isConfigSupported` returning true is a *capability*, and a capability is not a
// throughput. A software path that decodes 4K Main 10 at single-digit frames per second would produce
// a slideshow with a green tick beside it. The decode check (admin → System) measures the real thing;
// this module remembers its answer per device, so the player and the diagnostics can both read it
// without re-running it, and so a later session knows what this machine already proved.
//
// Pure rules over an injected { storage, now }, the same shape as lib/prefs.ts and
// lib/sportsGroups.ts, so the TTL, the parsing and the "usable" threshold are unit-tested rather
// than buried in a component.

export interface DecodeVerdict {
  /** When the measurement ran (epoch ms). */
  measuredAt: number
  /** Frames per second the decoder sustained, wall clock, as the check reports it. */
  framesPerSecond: number
  /** What the decoder actually presented — 0x0 means it produced no picture. */
  presentedWidth: number
  presentedHeight: number
  /** The codec string the platform accepted (e.g. hev1.1.6.L153.B0). */
  codec: string
}

/** Two weeks: long enough that a machine is measured once, short enough to notice a GPU/driver change. */
export const VERDICT_TTL_MS = 14 * 24 * 60 * 60 * 1000

/**
 * What "this device can carry a client-side player" means in numbers.
 *
 * 30 fps, not "more than zero": these streams are 50-60 fps, and a decode path that cannot exceed
 * realtime will fall behind the live edge no matter how well it starts. The decode check measures
 * throughput rather than pacing, so this is deliberately the *floor* — a device that clears it is
 * worth building for, and one that does not is worth saying no to.
 */
export const USABLE_FPS = 30

export const VERDICT_STORAGE_KEY = 'allison-web-iptv:client-decode-verdict'

const MAX_AGE_TEXT = { day: 86_400_000, hour: 3_600_000, minute: 60_000 } as const

/** Fresh, fast enough, and it actually produced a picture. */
export function verdictIsUsable(verdict: DecodeVerdict | null, now: number = Date.now()): boolean {
  if (!verdict) return false
  if (!Number.isFinite(verdict.framesPerSecond) || verdict.framesPerSecond < USABLE_FPS) return false
  if (!(verdict.presentedWidth > 0) || !(verdict.presentedHeight > 0)) return false
  return now - verdict.measuredAt < VERDICT_TTL_MS
}

/** One line for the diagnostics panel — says what was measured, when, and whether it is still current. */
export function describeVerdict(verdict: DecodeVerdict | null, now: number = Date.now()): string {
  if (!verdict) return 'not measured on this device — run the check in Admin → System'
  const age = now - verdict.measuredAt
  const stale = age >= VERDICT_TTL_MS
  const when = age < MAX_AGE_TEXT.minute ? 'just now' : formatAge(age)
  const size = verdict.presentedWidth > 0 ? `${verdict.presentedWidth}x${verdict.presentedHeight}` : 'no picture'
  const frames = Number.isFinite(verdict.framesPerSecond) ? `${verdict.framesPerSecond.toFixed(0)} fps` : 'unmeasured speed'
  return `${frames} at ${size} — measured ${when}${stale ? ' (stale, re-run it)' : ''}`
}

function formatAge(ageMs: number): string {
  if (ageMs < MAX_AGE_TEXT.hour) return `${Math.round(ageMs / MAX_AGE_TEXT.minute)} min ago`
  if (ageMs < MAX_AGE_TEXT.day) return `${Math.round(ageMs / MAX_AGE_TEXT.hour)} h ago`
  return `${Math.round(ageMs / MAX_AGE_TEXT.day)} d ago`
}

/** Tolerant: a corrupt or hand-edited value is "not measured", never an exception. */
export function parseVerdict(raw: string | null): DecodeVerdict | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<DecodeVerdict>
    if (typeof parsed?.measuredAt !== 'number' || !Number.isFinite(parsed.measuredAt)) return null
    if (typeof parsed.framesPerSecond !== 'number' || !Number.isFinite(parsed.framesPerSecond)) return null
    return {
      measuredAt: parsed.measuredAt,
      framesPerSecond: parsed.framesPerSecond,
      presentedWidth: typeof parsed.presentedWidth === 'number' ? parsed.presentedWidth : 0,
      presentedHeight: typeof parsed.presentedHeight === 'number' ? parsed.presentedHeight : 0,
      codec: typeof parsed.codec === 'string' ? parsed.codec : ''
    }
  } catch {
    return null
  }
}

export function serializeVerdict(verdict: DecodeVerdict): string {
  return JSON.stringify(verdict)
}

/** Storage can throw (private modes) — a diagnostic is not worth failing a render over. */
export function loadVerdict(storage?: Pick<Storage, 'getItem'>): DecodeVerdict | null {
  try {
    const store = storage ?? window.localStorage
    return parseVerdict(store.getItem(VERDICT_STORAGE_KEY))
  } catch {
    return null
  }
}

export function saveVerdict(verdict: DecodeVerdict, storage?: Pick<Storage, 'setItem'>): void {
  try {
    const store = storage ?? window.localStorage
    store.setItem(VERDICT_STORAGE_KEY, serializeVerdict(verdict))
  } catch {
    // See loadVerdict.
  }
}

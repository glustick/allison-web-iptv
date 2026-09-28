// The per-device verdict from the client-side decode check — the gate a client-side player consults.
//
// The roadmap's own order (2026-09-22) puts a measurement before the player, and for a reason worth
// restating: `isConfigSupported` returning true is a *capability*, and a capability is not a
// throughput. A software path that decodes 4K Main 10 at single-digit frames per second would produce
// a slideshow with a green tick beside it. The decode check (admin → System) measures the real thing;
// this module remembers its answer per device, so the player and the diagnostics can both read it
// without re-running it, and so a later session knows what this machine already proved.
//
// **What the verdict is for — corrected 2026-09-28 by the operator:** *"i dont want this player to
// need the rtx 3080 TI, its just one of the system i have available, it should run on a varity of
// systems with or without hardware accesleration."* So this is **not** a yes/no on whether one
// benchmark machine is good enough to build for: it is a **tier**, read per device, so a laptop, a
// phone or a browser with no GPU at all still gets the best path it can actually run — and the app
// stops treating one machine as the yardstick. Hardware decode is a fast path, never a requirement.
//
// Pure rules over an injected { storage, now }, the same shape as lib/prefs.ts and
// lib/sportsGroups.ts, so the TTL, the parsing and the tiers are unit-tested rather than buried in a
// component.

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
 * What a measurement means for *this* device — tiered, not a yes/no.
 *
 * "Cannot carry 4K" is not the same as "cannot carry this provider's HD channels", and a device that
 * can do neither is still better served by the server's own path than by nothing at all. The bars are
 * set against what these streams actually are — up to 50 fps UHD — rather than a synthetic benchmark.
 */
export type DecodeTier = 'comfortable' | 'marginal' | 'insufficient'

/** Clear headroom over a 50 fps stream: decode is not what will hold this device back. */
export const COMFORTABLE_FPS = 100

/**
 * Real-time-ish. A decode at this level drops frames and drifts behind the live edge rather than
 * stopping — and in a browser that cannot present HEVC any other way, that is still better than a
 * black screen, which is why "marginal" still counts as usable.
 */
export const MARGINAL_FPS = 30

export const VERDICT_STORAGE_KEY = 'allison-web-iptv:client-decode-verdict'

const MAX_AGE_TEXT = { day: 86_400_000, hour: 3_600_000, minute: 60_000 } as const

/** Which tier this device's last measurement put it in. */
export function tierForVerdict(verdict: DecodeVerdict | null, now: number = Date.now()): DecodeTier {
  if (!verdict) return 'insufficient'
  if (!Number.isFinite(verdict.framesPerSecond)) return 'insufficient'
  if (!(verdict.presentedWidth > 0) || !(verdict.presentedHeight > 0)) return 'insufficient'
  if (now - verdict.measuredAt >= VERDICT_TTL_MS) return 'insufficient'
  if (verdict.framesPerSecond >= COMFORTABLE_FPS) return 'comfortable'
  if (verdict.framesPerSecond >= MARGINAL_FPS) return 'marginal'
  return 'insufficient'
}

/**
 * Fresh, produced a picture, and fast enough to be worth trying — the two tiers above `insufficient`.
 * "Marginal" counts: on a device that cannot present HEVC at all, a decode that keeps up most of the
 * time is the difference between watching and not.
 */
export function verdictIsUsable(verdict: DecodeVerdict | null, now: number = Date.now()): boolean {
  return tierForVerdict(verdict, now) !== 'insufficient'
}

/** One line for the diagnostics panel — what was measured, when, and which tier it lands in. */
export function describeVerdict(verdict: DecodeVerdict | null, now: number = Date.now()): string {
  if (!verdict) return 'not measured on this device — run the check in Admin → System'
  const tier = tierForVerdict(verdict, now)
  const age = now - verdict.measuredAt
  const when = age < MAX_AGE_TEXT.minute ? 'just now' : formatAge(age)
  const size = verdict.presentedWidth > 0 ? `${verdict.presentedWidth}x${verdict.presentedHeight}` : 'no picture'
  const frames = Number.isFinite(verdict.framesPerSecond) ? `${verdict.framesPerSecond.toFixed(0)} fps` : 'unmeasured speed'
  // A verdict with no picture in it is not a device verdict. The check could only ever save one of
  // these by failing (a whole stream fed as a single chunk, before v0.61.6), so saying "not enough for
  // these channels" about it would report a broken measurement as a property of the machine.
  const noPicture = verdict.presentedWidth <= 0 || verdict.presentedHeight <= 0
  const tierText = noPicture
    ? 'the run produced no picture, so this is a failed measurement rather than a verdict — re-run it'
    : tier === 'comfortable'
      ? 'comfortable'
      : tier === 'marginal'
        ? 'marginal — may drop frames'
        : age >= VERDICT_TTL_MS
          ? 'stale, re-run it'
          : 'not enough for these channels'
  return `${frames} at ${size} — measured ${when} — ${tierText}`
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

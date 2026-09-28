import { createHash } from 'crypto'
import { fetchTextViaUpstream } from './upstreamText.js'
import { createNodeUpstreamRequest } from './nodeUpstreamRequest.js'

// api-football.com fixtures for the Sports tab — the score source. The provider's own channel
// names carry no scores (confirmed by the desktop sibling), so "Sunderland vs Newcastle live 0-0"
// can only come from a fixtures feed.
//
// The account's key is stored encrypted with the rest of its credentials (sessionStore.ts) and
// every request is made *here*, by the server — the same rule the provider credentials follow
// since v0.11.0: the browser never holds a credential, and never spends one.
//
// The host is pinned. The URL is built here from a fixed origin with only an ISO date
// interpolated, so nothing stored on an account can point this fetch somewhere else, and there is
// no user-supplied URL for an SSRF check to police.

export interface ApiFootballFixture {
  id: number
  /** Kickoff as an epoch instant (the feed's UTC date parsed), or null when it is unusable. */
  kickoffMs: number | null
  league: string
  country: string
  round: string
  homeTeam: string
  awayTeam: string
  homeGoals: number | null
  awayGoals: number | null
  live: boolean
  finished: boolean
  statusLong: string
}

export interface FixturesResult {
  fixtures: ApiFootballFixture[]
  error: string | null
}

interface RawFixture {
  fixture?: { id?: number; date?: string; status?: { short?: string; long?: string } }
  goals?: { home?: number | null; away?: number | null }
  teams?: { home?: { name?: string }; away?: { name?: string } }
  league?: { name?: string; country?: string; round?: string }
}

const API_ORIGIN = 'https://v3.football.api-sports.io'

// api-football's status.short codes: in-play variants vs. terminal ones. "NS" (not started) and the
// pre/post variants (TBD, PST, CANC, ABD, SUSP, AWD, WO) are deliberately in neither set — a
// postponed match is neither live nor finished, and the UI shows it as scheduled. Identical to the
// desktop app's own mapping, so both siblings read the same feed the same way.
const LIVE_SHORT_STATUSES = new Set(['1H', '2H', 'HT', 'ET', 'BT', 'P', 'LIVE', 'INT'])
const FINISHED_SHORT_STATUSES = new Set(['FT', 'AET', 'PEN'])

// A live score must be fresh; a day's fixture list must not be refetched per open tab. Five
// minutes matches the desktop app's own refetch cadence, and the cache is shared across accounts
// (fixtures are public data), which is also what keeps a free-tier key's daily quota intact.
const CACHE_TTL_MS = 5 * 60_000
// A failed answer is cached only briefly: a mistyped key must be correctable without waiting out
// the full window, while a short hold still stops a tight poll from spending quota on a feed that
// is refusing every request. And it is scoped to the key that produced it (see keyFingerprint), so
// simply entering a *different* key takes effect on the very next request regardless of the hold.
const ERROR_CACHE_TTL_MS = 60_000

/**
 * A non-reversible fingerprint of an API key, used only to tell "the same key that failed" from "a
 * different key" — never to authenticate. The raw key is never kept in the cache.
 */
function keyFingerprint(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 16)
}

export const FIXTURES_STALL_TIMEOUT_MS = 20_000
export const FIXTURES_RESPONSE_TIMEOUT_MS = 10_000

/** The pinned, server-built URL for one day's fixtures. `origin` is overridable for tests only. */
export function fixturesUrl(dateIso: string, origin: string = API_ORIGIN): string {
  return `${origin}/fixtures?date=${encodeURIComponent(dateIso)}`
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export function normalizeFixture(raw: RawFixture): ApiFootballFixture {
  const fixture = raw.fixture ?? {}
  const parsed = typeof fixture.date === 'string' ? Date.parse(fixture.date) : Number.NaN
  const short = String(fixture.status?.short ?? '')
  return {
    id: Number(fixture.id ?? 0),
    kickoffMs: Number.isFinite(parsed) ? parsed : null,
    league: String(raw.league?.name ?? ''),
    country: String(raw.league?.country ?? ''),
    round: String(raw.league?.round ?? ''),
    homeTeam: String(raw.teams?.home?.name ?? ''),
    awayTeam: String(raw.teams?.away?.name ?? ''),
    homeGoals: numberOrNull(raw.goals?.home),
    awayGoals: numberOrNull(raw.goals?.away),
    live: LIVE_SHORT_STATUSES.has(short),
    finished: FINISHED_SHORT_STATUSES.has(short),
    statusLong: String(fixture.status?.long ?? '')
  }
}

/**
 * api-football answers **200** with an in-band `errors` object for a bad key, a spent quota or a
 * malformed request — the HTTP status says nothing. Accepts the object, array and string shapes its
 * own docs show; an empty container is "no error", not an error with an empty message.
 */
export function describeInBandError(errors: unknown): string | null {
  if (errors == null) return null
  if (Array.isArray(errors)) {
    const parts = errors.map((v) => String(v).trim()).filter((v) => v.length > 0)
    return parts.length > 0 ? parts.join('; ') : null
  }
  if (typeof errors === 'object') {
    const parts = Object.values(errors as Record<string, unknown>)
      .filter((v) => v != null)
      .map((v) => String(v).trim())
      .filter((v) => v.length > 0)
    return parts.length > 0 ? parts.join('; ') : null
  }
  const text = String(errors).trim()
  return text.length > 0 ? text : null
}

export function parseFixturesResponse(body: string): FixturesResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return { fixtures: [], error: 'api-football returned a response that is not JSON' }
  }
  const root = parsed as { response?: unknown; errors?: unknown } | null
  const error = describeInBandError(root?.errors)
  if (error) return { fixtures: [], error }
  const raw = Array.isArray(root?.response) ? (root?.response as RawFixture[]) : []
  return { fixtures: raw.map(normalizeFixture).filter((fixture) => fixture.id > 0), error: null }
}

export interface SportsFixturesDeps {
  createUpstreamRequest?: typeof createNodeUpstreamRequest
  now?: () => number
  cacheTtlMs?: number
  /** Overridable for tests; production pins API_ORIGIN. */
  origin?: string
}

export function createSportsFixturesService(deps: SportsFixturesDeps = {}) {
  const createUpstreamRequest = deps.createUpstreamRequest ?? createNodeUpstreamRequest
  const now = deps.now ?? Date.now
  const cacheTtlMs = deps.cacheTtlMs ?? CACHE_TTL_MS
  const origin = deps.origin ?? API_ORIGIN
  const cache = new Map<string, { at: number; result: FixturesResult; keyHash: string }>()

  async function getFixtures(dateIso: string, key: string): Promise<FixturesResult> {
    const keyHash = keyFingerprint(key)
    const cached = cache.get(dateIso)
    // A cached *error* belongs to the key that produced it: a different key (a corrected one) must
    // not inherit it, so its window collapses to zero.
    const ttl = cached?.result.error ? (cached.keyHash === keyHash ? ERROR_CACHE_TTL_MS : 0) : cacheTtlMs
    if (cached && now() - cached.at < ttl) return cached.result

    let result: FixturesResult
    try {
      const body = await fetchTextViaUpstream(
        createUpstreamRequest,
        fixturesUrl(dateIso, origin),
        FIXTURES_STALL_TIMEOUT_MS,
        undefined,
        FIXTURES_RESPONSE_TIMEOUT_MS,
        undefined,
        { 'x-apisports-key': key }
      )
      result = parseFixturesResponse(body)
    } catch (err) {
      // A transport failure (or a slow day) is deliberately NOT cached for the full window: the
      // next poll should be allowed to succeed.
      return { fixtures: [], error: err instanceof Error ? err.message : String(err) }
    }

    cache.set(dateIso, { at: now(), result, keyHash })
    // One entry per day is all a session needs; the cap only guards against unbounded growth if a
    // client walks the whole ±7 range repeatedly.
    if (cache.size > 16) {
      const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at)[0]
      if (oldest) cache.delete(oldest[0])
    }
    return result
  }

  return {
    getFixtures,
    /** Test/ops hook. */
    clearCache(): void {
      cache.clear()
    }
  }
}

export type SportsFixturesService = ReturnType<typeof createSportsFixturesService>

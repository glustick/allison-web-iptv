import { createHash } from 'crypto'
import { fetchTextViaUpstream } from './upstreamText.js'
import { createNodeUpstreamRequest } from './nodeUpstreamRequest.js'
import type { SportsFixturesStore } from './sportsFixturesStore.js'

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
  /** Which sport's API this came from — the authoritative answer, not a guess from the league name. */
  sport: string
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

/**
 * The sports this key can reach, and where each one lives.
 *
 * api-sports runs a **separate host per sport** — football is `v3.football`, the others are
 * `v1.<sport>` — which is why the app showed only football for so long. The five original hosts were
 * confirmed to answer with this account's own key on 2026-09-28; american-football (NFL), AFL and
 * formula-1 were added 2026-09-30 on the operator's instruction ("AFL baseball basketball formula 1
 * NBA NFL are all missing api calls"), and their shapes are written tolerantly pending the same live
 * confirmation. Football's endpoint is `/fixtures`; the team sports are `/games`; formula-1 is
 * `/races` and is a *season* calendar filtered per day (see `normaliseRaces`). Only sports listed
 * here are fetched, so an unlisted one costs nothing rather than costing a failure.
 */
export interface SportApi {
  /** Matches the client's SportId (lib/sports.ts), so a fixture can be filed without translation. */
  sport: string
  label: string
  host: string
  path: '/fixtures' | '/games' | '/races'
}

export const SPORT_APIS: SportApi[] = [
  { sport: 'football', label: 'Football', host: 'v3.football.api-sports.io', path: '/fixtures' },
  { sport: 'basketball', label: 'Basketball (incl. NBA)', host: 'v1.basketball.api-sports.io', path: '/games' },
  { sport: 'american-football', label: 'American Football (NFL)', host: 'v1.american-football.api-sports.io', path: '/games' },
  { sport: 'baseball', label: 'Baseball (MLB)', host: 'v1.baseball.api-sports.io', path: '/games' },
  { sport: 'ice-hockey', label: 'Ice Hockey (NHL)', host: 'v1.hockey.api-sports.io', path: '/games' },
  { sport: 'aussie-rules', label: 'Aussie Rules (AFL)', host: 'v1.afl.api-sports.io', path: '/games' },
  { sport: 'rugby', label: 'Rugby', host: 'v1.rugby.api-sports.io', path: '/games' },
  { sport: 'motorsport', label: 'Motorsport (Formula 1)', host: 'v1.formula-1.api-sports.io', path: '/races' }
]

/**
 * Names a request might use for a sport that the table files under a different id. NBA has its own
 * dedicated host on api-sports, but its games are already inside basketball's `/games` — querying
 * both would double the request count for the same fixtures, so `nba` is an alias, not a second
 * entry. Same for the everyday spellings of NFL, AFL and F1.
 */
const SPORT_ALIASES: Record<string, string> = {
  nba: 'basketball',
  nfl: 'american-football',
  'american football': 'american-football',
  afl: 'aussie-rules',
  'formula-1': 'motorsport',
  formula1: 'motorsport',
  f1: 'motorsport',
  hockey: 'ice-hockey'
}

export function sportApiFor(sport: string): SportApi | null {
  const canonical = SPORT_ALIASES[sport] ?? sport
  return SPORT_APIS.find((api) => api.sport === canonical) ?? null
}

/** Every sport the key is expected to reach, football first. */
export const SPORT_API_IDS = SPORT_APIS.map((api) => api.sport)

// api-football's status.short codes: in-play variants vs. terminal ones. "NS" (not started) and the
// pre/post variants (TBD, PST, CANC, ABD, SUSP, AWD, WO) are deliberately in neither set — a
// postponed match is neither live nor finished, and the UI shows it as scheduled. Identical to the
// desktop app's own mapping, so both siblings read the same feed the same way.
// Q1-Q4 and OT are the american sports' in-play codes (NFL and AFL play in quarters, added
// 2026-09-30); the rest are football's, which the sibling hosts largely reuse.
const LIVE_SHORT_STATUSES = new Set(['1H', '2H', 'HT', 'ET', 'BT', 'P', 'LIVE', 'INT', 'Q1', 'Q2', 'Q3', 'Q4', 'OT'])
const FINISHED_SHORT_STATUSES = new Set(['FT', 'AET', 'PEN'])

// A live score must be fresh; a day's fixture list must not be refetched per open tab. Five
// minutes matches the desktop app's own refetch cadence, and the cache is shared across accounts
// (fixtures are public data), which is also what keeps a free-tier key's daily quota intact.
const LIVE_CACHE_TTL_MS = 5 * 60_000

/**
 * How long a day's fixtures are kept when **nothing in them is in play**.
 *
 * The distinction matters now that the plan is known to be a free one: `status` reports
 * `limit_day: 100`, and the Sports tab polls while it is open — twelve hours at a five-minute cadence
 * is 144 requests, more than the whole day's allowance. A fixture list with no live match in it does
 * not change from one minute to the next, so it is kept for an hour; only a day with something
 * actually being played is refreshed on the short cadence. Scores stay honest, and the quota survives.
 */
const IDLE_CACHE_TTL_MS = 60 * 60_000

/**
 * A formula-1 season calendar, once fetched. The calendar is published months ahead and changes
 * rarely, every day of it is served from the one answer, and the day's own live flags are derived
 * from the asking clock — so an hourly refresh would spend quota for nothing. One request a day
 * covers all of F1.
 */
const SEASON_CACHE_TTL_MS = 24 * 60 * 60_000

/**
 * Our own ceiling, below the plan's own. The API counts requests and refuses past 100; stopping short
 * means the app degrades to cached data and *says so*, instead of returning errors for the rest of the
 * day. Adding sports (basketball, baseball, hockey, rugby — all on this key) multiplies the request
 * count, which is why this guard went in before they did.
 */
const DAILY_REQUEST_BUDGET = 80
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

/** The same, for one sport's own host — the origin is overridable for tests only. */
export function sportUrl(api: SportApi, dateIso: string, originOverride?: string): string {
  const base = originOverride ? originOverride.replace(/\/+$/, '') : `https://${api.host}`
  // Formula-1 has no per-date query: its calendar is a season, and the day is filtered from it here.
  if (api.path === '/races') return `${base}${api.path}?season=${dateIso.slice(0, 4)}`
  return `${base}${api.path}?date=${encodeURIComponent(dateIso)}`
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
    sport: 'football',
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

/** The `/games` shape the non-football hosts use — basketball, baseball, hockey and rugby alike. */
export interface RawGame {
  id?: number
  date?: string
  status?: { short?: string; long?: string }
  league?: { name?: string; country?: string | null }
  country?: { name?: string } | null
  teams?: { home?: { name?: string }; away?: { name?: string } }
  /** Basketball nests a per-period object; hockey puts the number straight in. */
  scores?: {
    home?: number | { total?: number | null } | null
    away?: number | { total?: number | null } | null
  } | null
}

function scoreOf(side: number | { total?: number | null } | null | undefined): number | null {
  if (typeof side === 'number' && Number.isFinite(side)) return side
  if (side && typeof side === 'object') return numberOrNull(side.total)
  return null
}

/**
 * Normalises one `/games` entry from any sibling host into the shape the Sports tab already speaks.
 *
 * Deliberately **tolerant about the score** rather than per-sport: the hosts genuinely differ —
 * basketball sends `scores.home.total` (with per-quarter detail), hockey sends `scores.home` as a
 * plain number — and a reader that accepts both costs nothing and cannot be wrong about which sport is
 * which. Same for `league.country`, which the feed leaves null when it has none.
 */
export function normaliseGame(raw: RawGame, sport: string): ApiFootballFixture {
  const parsed = typeof raw.date === 'string' ? Date.parse(raw.date) : Number.NaN
  const short = String(raw.status?.short ?? '')
  return {
    id: Number(raw.id ?? 0),
    kickoffMs: Number.isFinite(parsed) ? parsed : null,
    sport,
    league: String(raw.league?.name ?? ''),
    country: String(raw.league?.country ?? raw.country?.name ?? ''),
    round: '',
    homeTeam: String(raw.teams?.home?.name ?? ''),
    awayTeam: String(raw.teams?.away?.name ?? ''),
    homeGoals: scoreOf(raw.scores?.home),
    awayGoals: scoreOf(raw.scores?.away),
    live: LIVE_SHORT_STATUSES.has(short),
    finished: FINISHED_SHORT_STATUSES.has(short),
    statusLong: String(raw.status?.long ?? '')
  }
}

/** The `/games` equivalent of `parseFixturesResponse`, with the same in-band error handling. */
export function parseGamesResponse(body: string, sport: string): FixturesResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return { fixtures: [], error: 'api-sports returned a response that is not JSON' }
  }
  const root = parsed as { response?: unknown; errors?: unknown } | null
  const error = describeInBandError(root?.errors)
  if (error) return { fixtures: [], error }
  const raw = Array.isArray(root?.response) ? (root?.response as RawGame[]) : []
  return { fixtures: raw.map((game) => normaliseGame(game, sport)).filter((fixture) => fixture.id > 0), error: null }
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

// --- Formula 1 ---------------------------------------------------------------------------------------
//
// The one sport in the catalogue that is not two teams and a score. `/races?season=` answers with a
// season calendar: each race carries its circuit and a set of *sessions* (practice, qualifying, the
// race) with their own instants. A session becomes a fixture — "British Grand Prix · Qualifying" at
// its own kickoff — so it lands in the day pane every other fixture lands in. There is no live score
// to carry: goals stay null, and live/finished are derived from the clock (see
// `refreshMotorSportFlags`) rather than a status code the feed does not have.

/** The session keys the feed names, in a sensible order; unknown keys still pass through under their own name. */
const SESSION_LABELS: Record<string, string> = {
  fp1: 'Practice 1', practice1: 'Practice 1',
  fp2: 'Practice 2', practice2: 'Practice 2',
  fp3: 'Practice 3', practice3: 'Practice 3',
  sprintqualifying: 'Sprint Qualifying', sq: 'Sprint Qualifying', sprint: 'Sprint',
  qualifying: 'Qualifying', q: 'Qualifying',
  race: 'Race'
}

/** A session instant the feed may send: an ISO string, or epoch seconds/milliseconds. */
function sessionInstant(value: unknown): number | null {
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 1e12 ? value * 1000 : value
  }
  return null
}

export interface RawRace {
  id?: number
  name?: string
  competition?: { name?: string }
  circuit?: { name?: string; country?: { name?: string } | string | null }
  country?: { name?: string } | string | null
  sessions?: Record<string, unknown> | null
}

function countryName(race: RawRace): string {
  const circuitCountry = race.circuit?.country
  const fromCircuit = typeof circuitCountry === 'string' ? circuitCountry : circuitCountry?.name
  const own = typeof race.country === 'string' ? race.country : race.country?.name
  return String(fromCircuit ?? own ?? '')
}

/**
 * A season of races into the fixture shape, every session its own row. `live`/`finished` are left
 * false here and derived at read time — a stored row can outlive the session it describes, and a
 * cached "live" flag would be a lie the next day.
 */
export function normaliseRaces(body: string): FixturesResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return { fixtures: [], error: 'formula-1 returned a response that is not JSON' }
  }
  const root = parsed as { response?: unknown; errors?: unknown } | null
  const error = describeInBandError(root?.errors)
  if (error) return { fixtures: [], error }
  const races = Array.isArray(root?.response) ? (root?.response as RawRace[]) : []
  const fixtures: ApiFootballFixture[] = []
  for (const race of races) {
    const raceId = Number(race.id ?? 0)
    if (raceId <= 0) continue
    const sessions = race.sessions ?? {}
    // Stable order: the label table's known keys first (practice → qualifying → race), then anything else.
    const keys = Object.keys(sessions).sort((a, b) => {
      const order = (key: string): number => Object.keys(SESSION_LABELS).indexOf(key.toLowerCase())
      const oa = order(a)
      const ob = order(b)
      return (oa < 0 ? 99 : oa) - (ob < 0 ? 99 : ob) || a.localeCompare(b)
    })
    let index = 0
    for (const key of keys) {
      const kickoffMs = sessionInstant(sessions[key])
      if (kickoffMs === null) continue
      const label = SESSION_LABELS[key.toLowerCase()] ?? key
      fixtures.push({
        id: raceId * 100 + index,
        kickoffMs,
        sport: 'motorsport',
        league: String(race.competition?.name ?? 'Formula 1'),
        country: countryName(race),
        round: label,
        homeTeam: String(race.name ?? ''),
        awayTeam: label,
        homeGoals: null,
        awayGoals: null,
        live: false,
        finished: false,
        statusLong: label
      })
      index += 1
    }
  }
  return { fixtures, error: null }
}

/** A race lasts about two hours; a practice or qualifying session about one. Derived, not fed. */
export function refreshMotorSportFlags(fixtures: ApiFootballFixture[], now: number): ApiFootballFixture[] {
  return fixtures.map((fixture) => {
    if (fixture.kickoffMs === null) return fixture
    const long = fixture.round === 'Race' || fixture.round === 'Sprint'
    const windowMs = (long ? 2 : 1) * 60 * 60_000
    const live = now >= fixture.kickoffMs && now < fixture.kickoffMs + windowMs
    const finished = now >= fixture.kickoffMs + windowMs
    if (live === fixture.live && finished === fixture.finished) return fixture
    return { ...fixture, live, finished }
  })
}

/** The sessions of a parsed season that fall on the requested UTC day. */
export function racesForDate(season: FixturesResult, dateIso: string): FixturesResult {
  if (season.error) return season
  return {
    fixtures: season.fixtures.filter((fixture) => fixture.kickoffMs !== null && new Date(fixture.kickoffMs).toISOString().slice(0, 10) === dateIso),
    error: null
  }
}

export interface SportsFixturesDeps {
  createUpstreamRequest?: typeof createNodeUpstreamRequest
  now?: () => number
  cacheTtlMs?: number
  /** Overridable for tests; production pins API_ORIGIN. */
  origin?: string
  /**
   * The persisted tier (lib/sportsFixturesStore.ts): answers already paid for, kept for seven days
   * on the data mount and consulted **before** any request is spent. Optional so the pure logic
   * stays testable without SQLite; production always passes one.
   */
  store?: SportsFixturesStore
}

/**
 * A stored day is *final* — its results can no longer change — once it was fetched after enough of
 * the following day had passed that even a late-running game would have finished and been recorded.
 * Twenty-six hours past the day's start covers a 23:55 UTC kickoff plus its result landing.
 */
const FINAL_AFTER_MS = 26 * 60 * 60_000

/** How long any answer is worth, given when it was taken and what day it describes. */
function ttlForResult(entry: { at: number; result: FixturesResult }, dateIso: string): number {
  if (entry.result.error) return ERROR_CACHE_TTL_MS
  if (entry.at - Date.parse(`${dateIso}T00:00:00Z`) >= FINAL_AFTER_MS) return Number.POSITIVE_INFINITY
  return entry.result.fixtures.some((fixture) => fixture.live) ? LIVE_CACHE_TTL_MS : IDLE_CACHE_TTL_MS
}

export function createSportsFixturesService(deps: SportsFixturesDeps = {}) {
  const createUpstreamRequest = deps.createUpstreamRequest ?? createNodeUpstreamRequest
  const now = deps.now ?? Date.now
  const origin = deps.origin ?? API_ORIGIN
  const store = deps.store ?? null
  // Overridable so a test can shorten the live window rather than waiting five minutes for it.
  const liveTtlMs = deps.cacheTtlMs ?? LIVE_CACHE_TTL_MS
  // Enough for every sport's whole ±7 day range: eight sports × nine days, plus the F1 season rows.
  const cache = new Map<string, { at: number; result: FixturesResult; keyHash: string }>()
  // Formula-1 answers a season at a time; the season is memoised so browsing its days costs one
  // request, and each day is then persisted separately like every other sport's.
  const seasonCache = new Map<string, { at: number; result: FixturesResult; keyHash: string }>()

  // Requests spent today, hydrated from the store on first ask (and on day rollover) so a restart
  // does not reset our own ceiling while the provider's keeps counting. Null until hydrated — a
  // fresh 0 here is exactly the restart bug this exists to prevent.
  let requestsToday: number | null = null
  let budgetDay = new Date(now()).toISOString().slice(0, 10)

  function budgetRemaining(at: number): number {
    const day = new Date(at).toISOString().slice(0, 10)
    if (day !== budgetDay) {
      budgetDay = day
      requestsToday = null
    }
    if (requestsToday === null) requestsToday = store?.readBudget(day) ?? 0
    return Math.max(0, DAILY_REQUEST_BUDGET - requestsToday)
  }

  function spendRequest(): void {
    requestsToday = (requestsToday ?? 0) + 1
    store?.writeBudget(budgetDay, requestsToday, now())
  }

  /** An answer leaves through here, so the one clock-derived sport gets fresh flags on every read. */
  function finish(api: SportApi, result: FixturesResult): FixturesResult {
    return api.path === '/races' ? { ...result, fixtures: refreshMotorSportFlags(result.fixtures, now()) } : result
  }

  async function getFixtures(dateIso: string, key: string): Promise<FixturesResult> {
    const keyHash = keyFingerprint(key)
    const cached = cache.get(dateIso)
    // A cached *error* belongs to the key that produced it: a different key (a corrected one) must
    // not inherit it, so its window collapses to zero.
    const ttl = cached?.result.error
      ? cached.keyHash === keyHash
        ? ERROR_CACHE_TTL_MS
        : 0
      : cached && cached.result.fixtures.some((fixture) => fixture.live)
        ? liveTtlMs
        : IDLE_CACHE_TTL_MS
    if (cached && now() - cached.at < ttl) return cached.result

    // Over our own daily budget: serve whatever is cached — even stale — and say why, rather than
    // spending a request that will not be replaced until tomorrow.
    if (budgetRemaining(now()) === 0) {
      if (cached) return cached.result
      return { fixtures: [], error: 'Daily api-football request budget reached — fixtures resume tomorrow' }
    }
    spendRequest()

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

  /**
   * One sport's day, cache-first all the way down: memory, then the persisted store, then — only
   * when neither has a fresh-enough answer — the API.
   *
   * The order is the operator's rule ("check that you have the data before you poll the API
   * again"): a stored answer costs nothing and survives restarts and image updates, and a **past
   * day is final** — fetched after the day fully ended, its results can never change, so it is
   * served from storage for its whole seven-day life without another request. Today keeps the live
   * and idle windows it always had, because a score that is an hour old is not a score.
   */
  async function getSportFixtures(api: SportApi, dateIso: string, key: string): Promise<FixturesResult> {
    const cacheKey = `${api.sport}|${dateIso}`
    const keyHash = keyFingerprint(key)

    // 1. Memory — the same-process answer, with its live/idle/final freshness.
    const cached = cache.get(cacheKey)
    if (cached) {
      const ttl = ttlForResult(cached, dateIso)
      const withinTtl = now() - cached.at < ttl
      // A cached error belongs only to the key that produced it — a corrected key goes straight through.
      if (withinTtl && (cached.result.error === null || cached.keyHash === keyHash)) {
        return cached.result.error === null ? finish(api, cached.result) : cached.result
      }
    }

    // 2. Storage — the answer a previous process (or a previous hour) already paid for.
    const stored = store?.get(api.sport, dateIso) ?? null
    if (stored && ttlForResult({ at: stored.fetchedAt, result: stored.result }, dateIso) > now() - stored.fetchedAt) {
      cache.set(cacheKey, { at: stored.fetchedAt, result: stored.result, keyHash })
      return finish(api, stored.result)
    }

    // 2b. A cached F1 season answers any of its days for free — the calendar is the cost, it is
    // already paid for, and the day's live flags are derived from the asking clock rather than the
    // feed, so a stale day row gains nothing by being re-asked while the season is in hand.
    if (api.path === '/races') {
      const seasonKey = `${api.sport}|season:${dateIso.slice(0, 4)}`
      const season = seasonCache.get(seasonKey)
      if (season && !season.result.error && now() - season.at < SEASON_CACHE_TTL_MS) {
        const fromSeason = racesForDate(season.result, dateIso)
        cache.set(cacheKey, { at: now(), result: fromSeason, keyHash })
        store?.put(api.sport, dateIso, fromSeason, now())
        return finish(api, fromSeason)
      }
    }

    // 3. The API — only now, and only if the day's allowance has something left.
    if (budgetRemaining(now()) === 0) {
      if (cached) return finish(api, cached.result)
      if (stored) return finish(api, stored.result)
      return { fixtures: [], error: 'Daily api-sports request budget reached — fixtures resume tomorrow' }
    }
    spendRequest()

    let result: FixturesResult
    try {
      if (api.path === '/races') {
        // One season fetch, memoised: browsing F1's days costs a single request while the season
        // cache lives, and each day's slice is persisted like any other sport's answer.
        const seasonKey = `${api.sport}|season:${dateIso.slice(0, 4)}`
        const seasonCached = seasonCache.get(seasonKey)
        let season = seasonCached && now() - seasonCached.at < SEASON_CACHE_TTL_MS ? seasonCached : null
        if (!season) {
          const body = await fetchTextViaUpstream(
            createUpstreamRequest,
            sportUrl(api, dateIso, origin),
            FIXTURES_STALL_TIMEOUT_MS,
            undefined,
            FIXTURES_RESPONSE_TIMEOUT_MS,
            undefined,
            { 'x-apisports-key': key }
          )
          season = { at: now(), result: normaliseRaces(body), keyHash }
          seasonCache.set(seasonKey, season)
        }
        // An in-band error is returned as the day's result (and cached briefly below, like every
        // other sport's error) rather than memoised as a broken season.
        result = season.result.error ? { fixtures: [], error: season.result.error } : racesForDate(season.result, dateIso)
        if (season.result.error) seasonCache.delete(seasonKey)
      } else {
        const body = await fetchTextViaUpstream(
          createUpstreamRequest,
          sportUrl(api, dateIso, origin),
          FIXTURES_STALL_TIMEOUT_MS,
          undefined,
          FIXTURES_RESPONSE_TIMEOUT_MS,
          undefined,
          { 'x-apisports-key': key }
        )
        result = api.path === '/fixtures' ? parseFixturesResponse(body) : parseGamesResponse(body, api.sport)
      }
    } catch (err) {
      return { fixtures: [], error: err instanceof Error ? err.message : String(err) }
    }

    cache.set(cacheKey, { at: now(), result, keyHash })
    if (!result.error) store?.put(api.sport, dateIso, result, now())
    if (cache.size > 72) {
      const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at)[0]
      if (oldest) cache.delete(oldest[0])
    }
    return finish(api, result)
  }

  /**
   * The day's fixtures across sports: football plus whatever else the key reaches.
   *
   * Each sport is fetched from its own host ({@link SPORT_APIS}) and carries the sport it came from —
   * which is the only authority on the question, and the reason the tab used to show football alone.
   * Errors are collected rather than thrown: one dead sport must not empty the pane.
   */
  async function getFixturesForSports(
    dateIso: string,
    key: string,
    sports: string[] = SPORT_API_IDS
  ): Promise<FixturesResult> {
    const apis = sports.map(sportApiFor).filter((api): api is SportApi => api !== null)
    const wanted = apis.length > 0 ? apis : SPORT_APIS.filter((api) => api.sport === 'football')
    const results = await Promise.all(wanted.map((api) => getSportFixtures(api, dateIso, key)))
    const errors = results.map((result) => result.error).filter((error): error is string => error !== null)
    return {
      fixtures: results.flatMap((result) => result.fixtures),
      // One error wins if it is the plan's date limit — the rest are almost always the same message.
      error: errors.length === 0 ? null : (errors.find((error) => /free plans|budget/i.test(error)) ?? errors[0])
    }
  }

  return {
    getFixtures,
    getFixturesForSports,
    /** Which sports are configured, for the client and for the admin screen. */
    sports(): SportApi[] {
      return SPORT_APIS.map((api) => ({ ...api }))
    },
    /** How much of our own daily allowance is left — for the admin screen, and for tests. */
    budget(): { remaining: number; used: number } {
      const remaining = budgetRemaining(now())
      return { remaining, used: requestsToday ?? 0 }
    },
    /** Test/ops hook. */
    clearCache(): void {
      cache.clear()
      seasonCache.clear()
    }
  }
}

export type SportsFixturesService = ReturnType<typeof createSportsFixturesService>

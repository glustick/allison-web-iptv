import { teamMatchKey } from './sports'
import type { LiveStream } from './types'

// Client side of the Sports tab's fixture feed. The feed itself is fetched by the *server* (see
// src/server/lib/sportsFixtures.ts) because the api-football key is a credential and must never
// reach the browser — this module only asks for a day's fixtures and indexes them so a provider
// game can find its score.

export interface ApiFootballFixture {
  id: number
  kickoffMs: number | null
  /** Which sport's API this came from. The authority on the question — the league name is not. */
  sport?: string
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

export interface FixturesResponse {
  /** False when the account has no api-football key — a normal state, not an error. */
  configured: boolean
  fixtures: ApiFootballFixture[]
  error: string | null
}

/** One sport the server will query for fixtures when a key is set. */
export interface SportFeed {
  sport: string
  label: string
}

/** What the persisted fixture cache holds (Admin → Sports data). */
export interface FixtureCacheInfo {
  days: number
  oldest: string | null
  newest: string | null
}

/** Whether this account has an api-football key set — and, for the admin screen, what it buys. */
export async function fetchSportsConfig(): Promise<{
  keySet: boolean
  sports?: SportFeed[]
  budget?: { remaining: number; used: number }
  cache?: FixtureCacheInfo
}> {
  const res = await fetch('/api/sports/config')
  if (!res.ok) throw new Error(`Could not read the sports settings (${res.status})`)
  const data = (await res.json()) as {
    keySet?: boolean
    sports?: SportFeed[]
    budget?: { remaining: number; used: number }
    cache?: FixtureCacheInfo
  }
  return {
    keySet: Boolean(data.keySet),
    sports: Array.isArray(data.sports) ? data.sports : undefined,
    budget: data.budget,
    cache: data.cache
  }
}

/**
 * Whether the feed's error is its **plan's date limit** rather than a fault.
 *
 * The free tier answers `Free plans do not have access to this date` for anything outside today ±1 —
 * measured on this deployment 2026-09-28, when a query for the following Saturday came back exactly
 * so. That is a fact about the subscription, not a failure, and saying "scores unavailable" about it
 * would send someone hunting for a bug that is not there. Anyone on a paid plan never sees this.
 */
export function isPlanDateLimit(error: string | null, maxDaysAhead = 1): boolean {
  if (typeof error !== 'string') return false
  if (maxDaysAhead > 1) return false
  return /free plans do not have access to this date/i.test(error)
}

/**
 * The key itself, for the admin screen's field (which shows it and lets it be changed). Admin-only
 * server-side; a non-admin gets a 403, which the caller shows as-is rather than retrying.
 */
export async function fetchSportsKey(): Promise<{
  key: string | null
  updatedAt: string | null
  updatedBy: string | null
}> {
  const res = await fetch('/api/sports/key')
  if (!res.ok) throw new Error(`Could not read the api-football key (${res.status})`)
  const data = (await res.json()) as { key?: unknown; updatedAt?: unknown; updatedBy?: unknown }
  return {
    key: typeof data.key === 'string' && data.key.length > 0 ? data.key : null,
    updatedAt: typeof data.updatedAt === 'string' ? data.updatedAt : null,
    updatedBy: typeof data.updatedBy === 'string' ? data.updatedBy : null
  }
}

/** Sets (or, with null, clears) the account's api-football key. The key itself is never returned. */
export async function saveSportsKey(key: string | null): Promise<{ keySet: boolean }> {
  const res = await fetch('/api/sports/key', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key })
  })
  const data = (await res.json().catch(() => ({}))) as { keySet?: boolean; error?: string }
  if (!res.ok) throw new Error(data.error ?? `Could not save the key (${res.status})`)
  return { keySet: Boolean(data.keySet) }
}

/** One day's fixtures (`dateIso` as YYYY-MM-DD). */
export async function fetchFixtures(dateIso: string): Promise<FixturesResponse> {
  const res = await fetch(`/api/sports/fixtures?date=${encodeURIComponent(dateIso)}`)
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(data.error ?? `Could not load fixtures (${res.status})`)
  }
  const data = (await res.json()) as Partial<FixturesResponse>
  return {
    configured: Boolean(data.configured),
    fixtures: Array.isArray(data.fixtures) ? (data.fixtures as ApiFootballFixture[]) : [],
    error: typeof data.error === 'string' ? data.error : null
  }
}

/**
 * The competitions the fixtures pane leads with, in the order a sports fan expects to see them —
 * the operator's ask (2026-10-02): "make sure that the most popular leagues are listed first, now
 * they are done via country." Alphabetical ordering scattered the Premier League among every
 * country's competitions; this table ranks the household names, matched as substrings so the feed's
 * own league names ("Premier League", "NBA", "Formula 1") land on their tier wherever they appear.
 * Everything unmatched shares one tier after these, alphabetical within each tier so the rest of
 * the list stays stable and findable.
 */
const POPULAR_COMPETITIONS = [
  'champions league',
  'premier league',
  'la liga',
  'serie a',
  'bundesliga',
  'ligue 1',
  'nba',
  'nfl',
  'mlb',
  'nhl',
  'afl',
  'formula 1',
  'mls',
  'championship',
  'eredivisie',
  'primeira liga',
  'liga mx',
  'brasileir',
  'saudi pro league',
  'super league',
  'europa league',
  'conference league',
  'world cup',
  'euros',
  'copa america',
  'ncaa'
]

/** Lower rank = more popular; unmatched competitions rank after every listed one. */
export function competitionPopularityRank(leagueName: string): number {
  const name = leagueName.toLowerCase()
  for (let i = 0; i < POPULAR_COMPETITIONS.length; i++) {
    if (name.includes(POPULAR_COMPETITIONS[i])) return i
  }
  return POPULAR_COMPETITIONS.length
}

/**
 * The fixtures pane's competition ordering: popular tiers first (in the table's order), then
 * everything else, alphabetical within each tier — stable between days, and a competition whose
 * feed name varies never jumps tiers because the matching is on substrings.
 */
export function compareCompetitionsByPopularity(a: string, b: string): number {
  const rankA = competitionPopularityRank(a)
  const rankB = competitionPopularityRank(b)
  if (rankA !== rankB) return rankA - rankB
  return a.localeCompare(b)
}

/**
 * The key a fixture and a provider game share when they are the same match: both sides normalized
 * through the provider parser's own team rules, then sorted — so "Newcastle United vs Sunderland"
 * and "Sunderland vs Newcastle" agree, and club suffixes ("Hull City AFC" / "Hull City") do too.
 */
export function fixtureMatchKey(fixture: { homeTeam: string; awayTeam: string }): string {
  return [teamMatchKey(fixture.homeTeam), teamMatchKey(fixture.awayTeam)].sort().join(' vs ')
}

/** Index a day's fixtures by match key, so each provider game finds its score. */
export function indexFixturesByMatch(fixtures: ApiFootballFixture[]): Map<string, ApiFootballFixture> {
  const byMatch = new Map<string, ApiFootballFixture>()
  for (const fixture of fixtures) {
    const key = fixtureMatchKey(fixture)
    // A live/finished entry wins a collision: it is the one that carries a score worth showing.
    const existing = byMatch.get(key)
    if (!existing || (!existing.live && !existing.finished && (fixture.live || fixture.finished))) {
      byMatch.set(key, fixture)
    }
  }
  return byMatch
}

// --- Pairing a day's fixtures with the provider's own game rows ------------------------------
//
// Tier 1 is the exact normalized pair. Tier 2 is the reason this exists: the provider and the feed
// spell clubs differently often enough that an exact key alone quietly loses matches — the feed's
// "Newcastle United" against the provider's "Newcastle", or "Hull City" against "Hull City AFC"
// (the parser drops the suffix, so that one already agrees). Everything here is deliberately
// conservative, because a *wrong* score beside a fixture is worse than a missing one.

// Words that describe half of football and so can never carry a match on their own.
const GENERIC_TEAM_TOKENS = new Set(['united', 'city', 'town', 'club', 'de', 'la', 'real', 'sport', 'sports'])

function pairSides(pairKey: string): [string, string] {
  const parts = pairKey.split(' vs ')
  return [parts[0] ?? '', parts[1] ?? '']
}

/**
 * Whether two normalized team keys can be the same club: identical, or every token of the shorter
 * present in the longer ("newcastle" ⊂ "newcastle united"). The shorter side must keep at least
 * one real word, so a lone "united" or "city" cannot claim a match by itself.
 */
export function sideLooselyMatches(a: string, b: string): boolean {
  if (!a || !b) return false
  if (a === b) return true
  const tokensA = a.split(' ').filter(Boolean)
  const tokensB = b.split(' ').filter(Boolean)
  if (tokensA.length === 0 || tokensB.length === 0) return false
  const [shorter, longer] = tokensA.length <= tokensB.length ? [tokensA, tokensB] : [tokensB, tokensA]
  if (!shorter.every((token) => longer.includes(token))) return false
  return shorter.some((token) => token.length >= 3 && !GENERIC_TEAM_TOKENS.has(token))
}

/** Whether two fixture pairs could be the same match, in either home/away order. */
export function loosePairMatches(gamePairKey: string, fixturePairKey: string): boolean {
  const [g1, g2] = pairSides(gamePairKey)
  const [f1, f2] = pairSides(fixturePairKey)
  return (
    (sideLooselyMatches(g1, f1) && sideLooselyMatches(g2, f2)) ||
    (sideLooselyMatches(g1, f2) && sideLooselyMatches(g2, f1))
  )
}

export interface FixturePairing {
  /** provider game key → the fixture that is that match. */
  byGame: Map<string, ApiFootballFixture>
  /** The ids of fixtures that claimed a game, i.e. are NOT provider-less. */
  matchedIds: Set<number>
}

/**
 * Pairs a day's fixtures with a day's provider games. Exact matches win first; then each remaining
 * game takes a loose match **only when exactly one fixture could claim it** — an ambiguous match is
 * no match, and the fixture stays available for another game.
 */
export function matchFixturesToGames(
  fixtures: ApiFootballFixture[],
  games: Array<{ key: string; pairKey: string }>
): FixturePairing {
  const byGame = new Map<string, ApiFootballFixture>()
  const matchedIds = new Set<number>()
  const exact = indexFixturesByMatch(fixtures)
  for (const game of games) {
    const fixture = exact.get(game.pairKey)
    if (fixture) {
      byGame.set(game.key, fixture)
      matchedIds.add(fixture.id)
    }
  }
  for (const game of games) {
    if (byGame.has(game.key)) continue
    const candidates = fixtures.filter(
      (fixture) => !matchedIds.has(fixture.id) && loosePairMatches(game.pairKey, fixtureMatchKey(fixture))
    )
    if (candidates.length === 1) {
      byGame.set(game.key, candidates[0])
      matchedIds.add(candidates[0].id)
    }
  }
  return { byGame, matchedIds }
}

// --- Finding a channel for a fixture the provider does not name -------------------------------

// Words that would match half a catalogue on their own, so a name search ignores them.
const SEARCH_STOPWORDS = new Set([
  'united', 'city', 'town', 'club', 'rovers', 'wanderers', 'athletic', 'albion', 'county', 'sporting',
  'sport', 'sports', 'the', 'real', 'de', 'la', 'fc', 'afc', 'sc', 'cf', 'ac', 'sv', 'as', 'ss', 'cd',
  'bk', 'if', 'fk', 'live', 'hd', 'fhd', 'uhd', 'feed', 'feeds'
])

/**
 * Channels whose names mention either team. This is the fallback behind a fixture the provider
 * does not carry under a recognisable name: it will not conjure a match, but it does surface the
 * channels that plausibly are about it (a club's own channel, a one-sided listing), ranked by how
 * many of the fixture's team words the name contains.
 */
export function channelsMentioningTeams(streams: LiveStream[], home: string, away: string): LiveStream[] {
  const tokens = new Set(
    [...teamMatchKey(home).split(' '), ...teamMatchKey(away).split(' ')].filter(
      (token) => token.length >= 4 && !SEARCH_STOPWORDS.has(token)
    )
  )
  if (tokens.size === 0) return []
  const hits: Array<{ channel: LiveStream; score: number }> = []
  for (const channel of streams) {
    const name = channel.name.toLowerCase()
    let score = 0
    for (const token of tokens) if (name.includes(token)) score += 1
    if (score > 0) hits.push({ channel, score })
  }
  return hits
    .sort((a, b) => b.score - a.score || a.channel.name.localeCompare(b.channel.name))
    .map((hit) => hit.channel)
}

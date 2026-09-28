import { teamMatchKey } from './sports'

// Client side of the Sports tab's fixture feed. The feed itself is fetched by the *server* (see
// src/server/lib/sportsFixtures.ts) because the api-football key is a credential and must never
// reach the browser — this module only asks for a day's fixtures and indexes them so a provider
// game can find its score.

export interface ApiFootballFixture {
  id: number
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

export interface FixturesResponse {
  /** False when the account has no api-football key — a normal state, not an error. */
  configured: boolean
  fixtures: ApiFootballFixture[]
  error: string | null
}

/** Whether this account has an api-football key set. */
export async function fetchSportsConfig(): Promise<{ keySet: boolean }> {
  const res = await fetch('/api/sports/config')
  if (!res.ok) throw new Error(`Could not read the sports settings (${res.status})`)
  const data = (await res.json()) as { keySet?: boolean }
  return { keySet: Boolean(data.keySet) }
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

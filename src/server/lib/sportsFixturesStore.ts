import type { Database } from 'better-sqlite3'
import { openDatabase } from './db.js'
import type { FixturesResult } from './sportsFixtures.js'

// The persisted half of the Sports tab's fixture cache.
//
// The API plan is free (100 requests/day, the app's own ceiling 80), and until now every answer
// lived only in memory: a restart — never mind an image update — meant re-fetching days the app had
// already paid for, and the request counter restarted with it while the provider's did not. This
// store puts both on disk, in the app's own SQLite database under DATA_DIR (the persisted volume),
// so an answer survives restarts and updates, and "we already have this" is a fact rather than a
// hope. The operator's rules, verbatim: **stored for reference for 7 days, any record more than 7
// days old should be purged** — and *check that you have the data before you poll the API again*
// (the freshness policy that decides when a stored row still counts lives in sportsFixtures.ts,
// next to the quota rules it serves).
//
// Same shape as channelPlans.ts: its own table, created additively, reached through the shared
// database file so it inherits WAL and the volume's persistence.

/** How long a stored day is kept for reference, whatever its freshness policy says. */
export const FIXTURES_RETENTION_MS = 7 * 24 * 60 * 60_000

export interface StoredFixtures {
  fetchedAt: number
  result: FixturesResult
}

export interface FixtureCacheStats {
  /** Distinct (sport, day) rows currently stored. */
  days: number
  /** The earliest day still stored, or null when the cache is empty. */
  oldest: string | null
  newest: string | null
}

export interface SportsFixturesStore {
  get(sport: string, dateIso: string): StoredFixtures | null
  put(sport: string, dateIso: string, result: FixturesResult, at: number): void
  /** Deletes rows older than the retention window; returns how many went. */
  purge(olderThanMs: number, at: number): number
  stats(): FixtureCacheStats
  /** Requests already spent on a UTC day, when this process is not the first to spend them. */
  readBudget(dayIso: string): number | null
  writeBudget(dayIso: string, used: number, at?: number): void
  /** Drops budget rows old enough that nobody will ask about them again. */
  pruneBudget(keepDays: number, at: number): void
}

export function createSportsFixturesStore(opts: { dataDir: string }): SportsFixturesStore {
  let handle: ReturnType<typeof openDatabase> | null = null
  const db = (): Database => {
    if (!handle) handle = openDatabase(opts.dataDir)
    return handle.db
  }

  function ensureTable(): void {
    db().exec(`
      CREATE TABLE IF NOT EXISTS sports_fixtures_cache (
        sport      TEXT NOT NULL,
        date       TEXT NOT NULL,
        payload    TEXT NOT NULL,
        fetched_at INTEGER NOT NULL,
        PRIMARY KEY (sport, date)
      );
      CREATE TABLE IF NOT EXISTS sports_fixtures_budget (
        day  TEXT PRIMARY KEY,
        used INTEGER NOT NULL
      )
    `)
  }

  function parsePayload(payload: string): FixturesResult | null {
    try {
      const parsed = JSON.parse(payload) as Partial<FixturesResult> | null
      if (!parsed || !Array.isArray(parsed.fixtures)) return null
      return { fixtures: parsed.fixtures, error: typeof parsed.error === 'string' ? parsed.error : null }
    } catch {
      return null
    }
  }

  ensureTable()

  return {
    get(sport, dateIso) {
      const row = db().prepare('SELECT payload, fetched_at FROM sports_fixtures_cache WHERE sport = ? AND date = ?').get(sport, dateIso) as
        | { payload: string; fetched_at: number }
        | undefined
      if (!row) return null
      const result = parsePayload(row.payload)
      // A payload that no longer parses is not an answer — drop the row so the next ask refetches
      // rather than serving a corrupt entry forever.
      if (!result) {
        db().prepare('DELETE FROM sports_fixtures_cache WHERE sport = ? AND date = ?').run(sport, dateIso)
        return null
      }
      return { fetchedAt: row.fetched_at, result }
    },

    put(sport, dateIso, result, at) {
      db()
        .prepare('INSERT OR REPLACE INTO sports_fixtures_cache (sport, date, payload, fetched_at) VALUES (?, ?, ?, ?)')
        .run(sport, dateIso, JSON.stringify(result), at)
      // The 7-day purge rides along with writes: cheap, and it keeps the reference window honest
      // even on an installation that never restarts.
      this.purge(FIXTURES_RETENTION_MS, at)
    },

    purge(olderThanMs, at) {
      const cutoff = at - olderThanMs
      return Number(db().prepare('DELETE FROM sports_fixtures_cache WHERE fetched_at < ?').run(cutoff).changes)
    },

    stats() {
      const row = db().prepare('SELECT COUNT(*) AS days, MIN(date) AS oldest, MAX(date) AS newest FROM sports_fixtures_cache').get() as
        | { days: number; oldest: string | null; newest: string | null }
        | undefined
      return { days: Number(row?.days ?? 0), oldest: row?.oldest ?? null, newest: row?.newest ?? null }
    },

    readBudget(dayIso) {
      const row = db().prepare('SELECT used FROM sports_fixtures_budget WHERE day = ?').get(dayIso) as { used: number } | undefined
      return row ? Number(row.used) : null
    },

    writeBudget(dayIso, used, at = Date.now()) {
      db().prepare('INSERT OR REPLACE INTO sports_fixtures_budget (day, used) VALUES (?, ?)').run(dayIso, used)
      this.pruneBudget(3, at)
    },

    pruneBudget(keepDays, at) {
      const cutoff = new Date(at - keepDays * 24 * 60 * 60_000).toISOString().slice(0, 10)
      db().prepare('DELETE FROM sports_fixtures_budget WHERE day < ?').run(cutoff)
    }
  }
}

import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { createSportsFixturesStore, FIXTURES_RETENTION_MS, type SportsFixturesStore } from './sportsFixturesStore.js'
import type { FixturesResult } from './sportsFixtures.js'

// The persisted fixtures tier, against a real SQLite file in a temp dir — the same convention as
// usersStore.test.ts, because a store that only passes against a fake is a store untested.

let dir: string
let store: SportsFixturesStore

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'allison-fixtures-'))
  store = createSportsFixturesStore({ dataDir: dir })
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const DAY = 24 * 60 * 60_000
const aResult = (home: string): FixturesResult => ({
  fixtures: [
    {
      id: 1,
      kickoffMs: Date.parse('2026-09-30T18:00:00Z'),
      sport: 'football',
      league: 'Premier League',
      country: 'England',
      round: '',
      homeTeam: home,
      awayTeam: 'Opponent',
      homeGoals: null,
      awayGoals: null,
      live: false,
      finished: false,
      statusLong: 'Not Started'
    }
  ],
  error: null
})

describe('sportsFixturesStore', () => {
  it('round-trips a day\'s answer with the moment it was taken', () => {
    const at = Date.parse('2026-09-30T10:00:00Z')
    store.put('football', '2026-09-30', aResult('Sunderland'), at)
    const read = store.get('football', '2026-09-30')
    expect(read?.fetchedAt).toBe(at)
    expect(read?.result.fixtures[0]).toMatchObject({ homeTeam: 'Sunderland' })
    expect(store.get('basketball', '2026-09-30')).toBeNull()
    expect(store.get('football', '2026-09-29')).toBeNull()
  })

  it('keeps one row per (sport, day) — a refetch replaces, it does not accumulate', () => {
    const at = Date.now()
    store.put('rugby', '2026-09-30', aResult('first'), at)
    store.put('rugby', '2026-09-30', aResult('second'), at + 1000)
    expect(store.get('rugby', '2026-09-30')?.result.fixtures[0]).toMatchObject({ homeTeam: 'second' })
    expect(store.stats().days).toBe(1)
  })

  it('purges rows past the seven-day window, on write and on demand', () => {
    const now = Date.parse('2026-09-30T12:00:00Z')
    // Written 8 days ago: gone the moment anything else is written.
    store.put('football', '2026-09-18', aResult('old'), now - (FIXTURES_RETENTION_MS + DAY))
    store.put('football', '2026-09-30', aResult('new'), now - 1000)
    expect(store.get('football', '2026-09-18')).toBeNull()
    expect(store.get('football', '2026-09-30')).not.toBeNull()

    // And directly, for the boot-time sweep.
    store.put('baseball', '2026-09-10', aResult('ancient'), now - 20 * DAY)
    const purged = store.purge(FIXTURES_RETENTION_MS, now)
    expect(purged).toBe(1)
    expect(store.get('baseball', '2026-09-10')).toBeNull()
  })

  it('treats a payload that no longer parses as no answer, and drops it', () => {
    const at = Date.now()
    store.put('ice-hockey', '2026-09-30', aResult('Bruins'), at)
    expect(store.get('ice-hockey', '2026-09-30')).not.toBeNull()
    // Hand-corrupt the row the way a truncated write or an editor would.
    const raw = new Database(join(dir, 'allison.db'))
    raw.prepare("UPDATE sports_fixtures_cache SET payload = '{not json'").run()
    raw.close()
    expect(store.get('ice-hockey', '2026-09-30')).toBeNull()
    // ...and the row is gone, so the next ask refetches rather than failing forever.
    const rawAgain = new Database(join(dir, 'allison.db'))
    const rows = rawAgain.prepare('SELECT COUNT(*) AS n FROM sports_fixtures_cache').get() as { n: number }
    rawAgain.close()
    expect(rows.n).toBe(0)
  })

  it('reports what is stored, for the admin screen', () => {
    expect(store.stats()).toEqual({ days: 0, oldest: null, newest: null })
    const at = Date.now()
    store.put('football', '2026-09-29', aResult('a'), at)
    store.put('motorsport', '2026-09-30', aResult('b'), at)
    const stats = store.stats()
    expect(stats.days).toBe(2)
    expect(stats.oldest).toBe('2026-09-29')
    expect(stats.newest).toBe('2026-09-30')
  })

  it('remembers the requests a previous process spent on the day', () => {
    const day = '2026-09-30'
    expect(store.readBudget(day)).toBeNull()
    store.writeBudget(day, 17, Date.parse('2026-09-30T09:00:00Z'))
    expect(store.readBudget(day)).toBe(17)
    store.writeBudget(day, 18, Date.parse('2026-09-30T09:05:00Z'))
    expect(store.readBudget(day)).toBe(18)
    // A fresh store over the same file inherits the count — the restart case.
    const reopened = createSportsFixturesStore({ dataDir: dir })
    expect(reopened.readBudget(day)).toBe(18)
    // And old budget rows do not accumulate forever.
    reopened.writeBudget('2026-09-01', 80, Date.parse('2026-09-30T09:00:00Z'))
    reopened.pruneBudget(3, Date.parse('2026-09-30T09:00:00Z'))
    expect(reopened.readBudget('2026-09-01')).toBeNull()
    expect(reopened.readBudget(day)).toBe(18)
  })
})

import type { Database } from 'better-sqlite3'
import { openDatabase } from './db.js'
import { normalizeName, tokenSetScore } from './epgMatching.js'
import type { MediaKind } from './prefsStore.js'
import type { IndexRow } from './providerLists.js'

// Search over the provider's whole catalogue, held in SQLite so it is instant after the first
// build and — importantly — still works when the provider is slow, flaky or down. The index is
// rebuilt on demand and nothing else depends on it.
//
// Candidate retrieval is a LIKE scan over the tokenised name; ranking then reuses the same
// fuzzy token scorer the EPG matching uses, so "sky sports 1" finds "Sky Sports One HD" and
// "bbcone" finds "BBC One". Deliberately one code path rather than an FTS5 fast path plus a
// fallback: this has to work identically on every SQLite build.

const MAX_CANDIDATES = 400
const DEFAULT_LIMIT = 40

// Search tokenises differently from guide matching on purpose. The matcher strips packaging noise
// ("Channel", "TV", "HD") because it is deciding *identity* — but a person searching sees those
// words in the name and will type them, so dropping them made "Discovery Channel" unfindable by
// "channel". Only number words are folded, matching what the eye reads as the same thing
// ("Sky Sports One" is "Sky Sports 1").
const NUMBER_WORDS: Record<string, string> = {
  one: '1',
  two: '2',
  three: '3',
  four: '4',
  five: '5',
  six: '6',
  seven: '7',
  eight: '8',
  nine: '9',
  ten: '10',
  eleven: '11',
  twelve: '12'
}

export function searchTokens(name: string): string[] {
  return normalizeName(name)
    .split(' ')
    .filter(Boolean)
    .map((token) => NUMBER_WORDS[token] ?? token)
}

export interface SearchHit {
  kind: MediaKind
  streamId: number
  name: string
  category: string | null
  icon: string | null
  score: number
}

export interface SearchIndexStats {
  live: number
  movie: number
  series: number
  total: number
  indexedAt: string | null
}

interface Row {
  kind: string
  stream_id: number
  name: string
  category: string | null
  stream_icon: string | null
  tokens: string
}

export interface SearchStore {
  replaceKind(kind: MediaKind, rows: IndexRow[]): number
  clear(): void
  stats(): SearchIndexStats
  search(query: string, limit?: number, kind?: MediaKind): SearchHit[]
  isStale(maxAgeMs: number): boolean
}

export function createSearchStore({ dataDir }: { dataDir: string }): SearchStore {
  let handle: { db: Database; close: () => void } | null = null
  let openError: string | null = null
  try {
    handle = openDatabase(dataDir)
  } catch (err) {
    openError = err instanceof Error ? err.message : String(err)
  }

  function requireDb(): Database {
    if (!handle) throw new Error(`Search database is not usable: ${openError ?? 'unknown error'}`)
    return handle.db
  }

  return {
    replaceKind(kind: MediaKind, rows: IndexRow[]): number {
      const db = requireDb()
      const insert = db.prepare(
        `INSERT INTO search_index (kind, stream_id, name, category, stream_icon, tokens)
         VALUES (@kind, @streamId, @name, @category, @icon, @tokens)
         ON CONFLICT (kind, stream_id)
         DO UPDATE SET name = excluded.name, category = excluded.category, stream_icon = excluded.stream_icon, tokens = excluded.tokens`
      )
      db.transaction(() => {
        db.prepare('DELETE FROM search_index WHERE kind = ?').run(kind)
        for (const row of rows) {
          insert.run({
            kind: row.kind,
            streamId: row.streamId,
            name: row.name,
            category: row.category,
            icon: row.icon,
            // Stored pre-tokenised with the same normalisation the matcher uses, so searching and
            // matching can't disagree about what "HD" or "one" means.
            tokens: searchTokens(row.name).join(' ')
          })
        }
        db.prepare('INSERT OR REPLACE INTO search_meta (key, value) VALUES (?, ?)').run(
          `indexed_at_${kind}`,
          new Date().toISOString()
        )
      })()
      return rows.length
    },

    clear(): void {
      const db = requireDb()
      db.transaction(() => {
        db.prepare('DELETE FROM search_index').run()
        db.prepare("DELETE FROM search_meta WHERE key LIKE 'indexed_at_%'").run()
      })()
    },

    stats(): SearchIndexStats {
      const db = requireDb()
      const counts = db.prepare('SELECT kind, COUNT(*) AS count FROM search_index GROUP BY kind').all() as Array<{
        kind: string
        count: number
      }>
      const byKind = new Map(counts.map((row) => [row.kind, row.count]))
      const indexed = db.prepare("SELECT value FROM search_meta WHERE key = 'indexed_at_live'").get() as
        | { value: string }
        | undefined
      const live = byKind.get('live') ?? 0
      const movie = byKind.get('movie') ?? 0
      const series = byKind.get('series') ?? 0
      return { live, movie, series, total: live + movie + series, indexedAt: indexed?.value ?? null }
    },

    isStale(maxAgeMs: number): boolean {
      const indexedAt = this.stats().indexedAt
      if (!indexedAt) return true
      const age = Date.now() - new Date(indexedAt).getTime()
      return !Number.isFinite(age) || age > maxAgeMs
    },

    search(query: string, limit = DEFAULT_LIMIT, kind?: MediaKind): SearchHit[] {
      const db = requireDb()
      const queryTokens = searchTokens(query)
      if (queryTokens.length === 0) return []

      // Retrieve on the longest token (the most selective one), then enforce every token as a
      // prefix match in JS before ranking — a LIKE prefilter only narrows, it never decides.
      const anchor = [...queryTokens].sort((a, b) => b.length - a.length)[0]
      const where = kind ? 'tokens LIKE ? AND kind = ?' : 'tokens LIKE ?'
      const params: unknown[] = [`%${anchor}%`]
      if (kind) params.push(kind)
      const rows = db
        .prepare(`SELECT kind, stream_id, name, category, stream_icon, tokens FROM search_index WHERE ${where} LIMIT ${MAX_CANDIDATES}`)
        .all(...params) as Row[]

      const hits: SearchHit[] = []
      for (const row of rows) {
        const nameTokens = row.tokens.split(' ').filter(Boolean)
        const allMatch = queryTokens.every((token) =>
          nameTokens.some((candidate) => candidate === token || candidate.startsWith(token))
        )
        if (!allMatch) continue
        hits.push({
          kind: row.kind as MediaKind,
          streamId: row.stream_id,
          name: row.name,
          category: row.category,
          icon: row.stream_icon,
          score: tokenSetScore(queryTokens, nameTokens)
        })
      }
      hits.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
      return hits.slice(0, limit)
    }
  }
}

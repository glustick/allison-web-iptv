import type { Database } from 'better-sqlite3'
import { openDatabase } from './db.js'

// The EPG source list is a **system** setting, not an account one: one household, one set of
// guides. It lives in the same SQLite database as everything else (db.ts) under a single `meta`
// row, so it survives restarts and image updates and is never rebuilt per login.
//
// Only an admin may write it (enforced at the endpoint, requireAdmin); every signed-in user reads
// it. The provider's *own* guide is not part of this — it is derived from whichever account is
// asking, because it is addressed with that account's credentials.

const META_KEY = 'epg_sources'

export interface SystemEpgConfig {
  urls: string[]
  updatedAt: string | null
  updatedBy: string | null
}

export interface SystemEpgStore {
  read(): SystemEpgConfig
  write(urls: string[], updatedBy: string): SystemEpgConfig
  /** Whether the setting has ever been written — the migration reads this exactly once. */
  hasStoredConfig(): boolean
}

export function createSystemEpgStore(opts: { dataDir: string }): SystemEpgStore {
  let handle: ReturnType<typeof openDatabase> | null = null
  const db = (): Database => {
    if (!handle) handle = openDatabase(opts.dataDir)
    return handle.db
  }

  function read(): SystemEpgConfig {
    let row: { value: string } | undefined
    try {
      row = db().prepare('SELECT value FROM meta WHERE key = ?').get(META_KEY) as { value: string } | undefined
    } catch (err) {
      console.error('[epg] could not read the system guide sources:', err instanceof Error ? err.message : err)
      return { urls: [], updatedAt: null, updatedBy: null }
    }
    if (!row) return { urls: [], updatedAt: null, updatedBy: null }
    try {
      const parsed = JSON.parse(row.value) as { urls?: unknown; updatedAt?: unknown; updatedBy?: unknown }
      const urls = Array.isArray(parsed.urls)
        ? parsed.urls.filter((url): url is string => typeof url === 'string' && url.length > 0)
        : []
      return {
        urls,
        updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null,
        updatedBy: typeof parsed.updatedBy === 'string' ? parsed.updatedBy : null
      }
    } catch {
      // A corrupt row must not take the guide down: an empty list is recoverable (the admin
      // re-adds a source), while throwing here would fail every EPG request.
      return { urls: [], updatedAt: null, updatedBy: null }
    }
  }

  function write(urls: string[], updatedBy: string): SystemEpgConfig {
    const config: SystemEpgConfig = { urls, updatedAt: new Date().toISOString(), updatedBy }
    db().prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(META_KEY, JSON.stringify(config))
    return config
  }

  function hasStoredConfig(): boolean {
    try {
      return Boolean(db().prepare('SELECT 1 FROM meta WHERE key = ?').get(META_KEY))
    } catch {
      return false
    }
  }

  return { read, write, hasStoredConfig }
}

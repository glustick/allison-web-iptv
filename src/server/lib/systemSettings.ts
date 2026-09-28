import type { Database } from 'better-sqlite3'
import { openDatabase } from './db.js'

// The app's **system-wide** settings: one value per key, in the same SQLite database as everything
// else, so they survive restarts and image updates and are shared by every account rather than
// living on one.
//
// Each feature owns its own key and its own shape (see systemEpg.ts for the guide sources, and
// index.ts for the api-football key). This module owns only the storage and its failure posture:
// a missing or unreadable value is a recoverable "not set", never an exception, because every
// caller has a sensible default and a settings read must not be able to fail a request.

export interface SystemSettingsStore {
  read<T>(key: string): T | null
  write(key: string, value: unknown): void
  has(key: string): boolean
}

export function createSystemSettingsStore(opts: { dataDir: string }): SystemSettingsStore {
  let handle: ReturnType<typeof openDatabase> | null = null
  const db = (): Database => {
    if (!handle) handle = openDatabase(opts.dataDir)
    return handle.db
  }

  function read<T>(key: string): T | null {
    try {
      const row = db().prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined
      if (!row) return null
      return JSON.parse(row.value) as T
    } catch (err) {
      console.error(`[settings] could not read "${key}":`, err instanceof Error ? err.message : err)
      return null
    }
  }

  function write(key: string, value: unknown): void {
    db().prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, JSON.stringify(value))
  }

  function has(key: string): boolean {
    try {
      return Boolean(db().prepare('SELECT 1 FROM meta WHERE key = ?').get(key))
    } catch {
      return false
    }
  }

  return { read, write, has }
}

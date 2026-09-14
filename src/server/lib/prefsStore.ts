import type { Database } from 'better-sqlite3'
import { openDatabase } from './db.js'

// Per-user library data: favourites, watch history, and custom categories. All three live in the
// same SQLite database as the accounts (db.ts), which is what makes them survive an update —
// nothing here is written anywhere else, and nothing is held only in the browser.
//
// The denormalised name/category columns are deliberate: a provider that renumbers or drops a
// channel must not silently blank out someone's favourites and history.

export type MediaKind = 'live' | 'movie' | 'series'

const KINDS: readonly MediaKind[] = ['live', 'movie', 'series']
const MAX_NAME_LENGTH = 200
const MAX_CATEGORY_NAME_LENGTH = 40
const HISTORY_LIMIT_PER_USER = 500

export interface Favourite {
  kind: MediaKind
  streamId: number
  name: string
  category: string | null
  addedAt: string
}

export interface HistoryEntry {
  id: number
  kind: MediaKind
  streamId: number
  name: string
  category: string | null
  watchedAt: string
}

export interface CustomCategoryChannel {
  kind: MediaKind
  streamId: number
  name: string
  sourceCategory: string | null
  position: number
}

export interface CustomCategory {
  id: number
  name: string
  position: number
  channels: CustomCategoryChannel[]
}

export class PrefsError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PrefsError'
  }
}

export interface ChannelRef {
  kind: MediaKind
  streamId: number
  name: string
  category?: string | null
}

function validateKind(kind: unknown): MediaKind {
  if (typeof kind !== 'string' || !KINDS.includes(kind as MediaKind)) {
    throw new PrefsError('kind must be one of: live, movie, series')
  }
  return kind as MediaKind
}

function validateStreamId(streamId: unknown): number {
  const value = Number(streamId)
  if (!Number.isFinite(value)) throw new PrefsError('streamId must be a number')
  return value
}

function cleanName(name: unknown, label: string, max: number): string {
  if (typeof name !== 'string') throw new PrefsError(`${label} is required`)
  const trimmed = name.trim()
  if (trimmed.length === 0) throw new PrefsError(`${label} is required`)
  if (trimmed.length > max) throw new PrefsError(`${label} must be ${max} characters or fewer`)
  return trimmed
}

export interface PrefsStore {
  listFavourites(username: string): Favourite[]
  setFavourite(username: string, channel: ChannelRef, favourite: boolean): void
  listHistory(username: string, limit?: number): HistoryEntry[]
  recordHistory(username: string, channel: ChannelRef): void
  clearHistory(username: string): void
  listCategories(username: string): CustomCategory[]
  createCategory(username: string, name: string): CustomCategory
  renameCategory(username: string, id: number, name: string): void
  deleteCategory(username: string, id: number): void
  addChannelToCategory(username: string, id: number, channel: ChannelRef): void
  removeChannelFromCategory(username: string, id: number, kind: MediaKind, streamId: number): void
}

export function createPrefsStore({ dataDir }: { dataDir: string }): PrefsStore {
  let handle: { db: Database; close: () => void } | null = null
  let openError: string | null = null
  try {
    handle = openDatabase(dataDir)
  } catch (err) {
    openError = err instanceof Error ? err.message : String(err)
  }

  function requireDb(): Database {
    if (!handle) throw new PrefsError(`Preference database is not usable: ${openError ?? 'unknown error'}`)
    return handle.db
  }

  function categoryById(db: Database, username: string, id: number): { id: number; name: string } | undefined {
    return db.prepare('SELECT id, name FROM custom_categories WHERE id = ? AND username = ?').get(id, username) as
      | { id: number; name: string }
      | undefined
  }

  return {
    listFavourites(username: string): Favourite[] {
      const db = requireDb()
      const rows = db
        .prepare('SELECT kind, stream_id, name, category, added_at FROM favourites WHERE username = ? ORDER BY added_at DESC')
        .all(username) as Array<{ kind: string; stream_id: number; name: string; category: string | null; added_at: string }>
      return rows.map((row) => ({
        kind: validateKind(row.kind),
        streamId: row.stream_id,
        name: row.name,
        category: row.category,
        addedAt: row.added_at
      }))
    },

    setFavourite(username: string, channel: ChannelRef, favourite: boolean): void {
      const db = requireDb()
      const kind = validateKind(channel.kind)
      const streamId = validateStreamId(channel.streamId)
      const name = cleanName(channel.name, 'name', MAX_NAME_LENGTH)
      if (favourite) {
        db.prepare(
          `INSERT INTO favourites (username, kind, stream_id, name, category, added_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (username, kind, stream_id)
           DO UPDATE SET name = excluded.name, category = excluded.category`
        ).run(username, kind, streamId, name, channel.category ?? null, new Date().toISOString())
      } else {
        db.prepare('DELETE FROM favourites WHERE username = ? AND kind = ? AND stream_id = ?').run(username, kind, streamId)
      }
    },

    listHistory(username: string, limit = 100): HistoryEntry[] {
      const db = requireDb()
      const capped = Math.min(Math.max(1, Math.floor(limit)), HISTORY_LIMIT_PER_USER)
      const rows = db
        .prepare('SELECT id, kind, stream_id, name, category, watched_at FROM history WHERE username = ? ORDER BY watched_at DESC, id DESC LIMIT ?')
        .all(username, capped) as Array<{ id: number; kind: string; stream_id: number; name: string; category: string | null; watched_at: string }>
      return rows.map((row) => ({
        id: row.id,
        kind: validateKind(row.kind),
        streamId: row.stream_id,
        name: row.name,
        category: row.category,
        watchedAt: row.watched_at
      }))
    },

    recordHistory(username: string, channel: ChannelRef): void {
      const db = requireDb()
      const kind = validateKind(channel.kind)
      const streamId = validateStreamId(channel.streamId)
      const name = cleanName(channel.name, 'name', MAX_NAME_LENGTH)
      db.transaction(() => {
        db.prepare('INSERT INTO history (username, kind, stream_id, name, category, watched_at) VALUES (?, ?, ?, ?, ?, ?)').run(
          username,
          kind,
          streamId,
          name,
          channel.category ?? null,
          new Date().toISOString()
        )
        // Keep the table bounded: history is a convenience list, not an audit log.
        db.prepare(
          `DELETE FROM history
            WHERE username = ?
              AND id NOT IN (SELECT id FROM history WHERE username = ? ORDER BY watched_at DESC, id DESC LIMIT ?)`
        ).run(username, username, HISTORY_LIMIT_PER_USER)
      })()
    },

    clearHistory(username: string): void {
      requireDb().prepare('DELETE FROM history WHERE username = ?').run(username)
    },

    listCategories(username: string): CustomCategory[] {
      const db = requireDb()
      const categories = db
        .prepare('SELECT id, name, position FROM custom_categories WHERE username = ? ORDER BY position, name COLLATE NOCASE')
        .all(username) as Array<{ id: number; name: string; position: number }>
      const channelsFor = db.prepare(
        'SELECT kind, stream_id, name, source_category, position FROM custom_category_channels WHERE category_id = ? ORDER BY position, name COLLATE NOCASE'
      )
      return categories.map((category) => ({
        id: category.id,
        name: category.name,
        position: category.position,
        channels: (channelsFor.all(category.id) as Array<{ kind: string; stream_id: number; name: string; source_category: string | null; position: number }>).map(
          (row) => ({
            kind: validateKind(row.kind),
            streamId: row.stream_id,
            name: row.name,
            sourceCategory: row.source_category,
            position: row.position
          })
        )
      }))
    },

    createCategory(username: string, name: string): CustomCategory {
      const db = requireDb()
      const cleaned = cleanName(name, 'Category name', MAX_CATEGORY_NAME_LENGTH)
      const existing = db
        .prepare('SELECT name FROM custom_categories WHERE username = ? AND name = ? COLLATE NOCASE')
        .get(username, cleaned) as { name: string } | undefined
      if (existing) throw new PrefsError(`A category called "${cleaned}" already exists`)
      const position =
        ((db.prepare('SELECT MAX(position) AS max FROM custom_categories WHERE username = ?').get(username) as { max: number | null }).max ?? -1) + 1
      const info = db
        .prepare('INSERT INTO custom_categories (username, name, position, created_at) VALUES (?, ?, ?, ?)')
        .run(username, cleaned, position, new Date().toISOString())
      return { id: Number(info.lastInsertRowid), name: cleaned, position, channels: [] }
    },

    renameCategory(username: string, id: number, name: string): void {
      const db = requireDb()
      const cleaned = cleanName(name, 'Category name', MAX_CATEGORY_NAME_LENGTH)
      if (!categoryById(db, username, id)) throw new PrefsError('That category does not exist')
      const clash = db
        .prepare('SELECT id FROM custom_categories WHERE username = ? AND name = ? COLLATE NOCASE AND id <> ?')
        .get(username, cleaned, id) as { id: number } | undefined
      if (clash) throw new PrefsError(`A category called "${cleaned}" already exists`)
      db.prepare('UPDATE custom_categories SET name = ? WHERE id = ? AND username = ?').run(cleaned, id, username)
    },

    deleteCategory(username: string, id: number): void {
      const db = requireDb()
      if (!categoryById(db, username, id)) throw new PrefsError('That category does not exist')
      db.transaction(() => {
        db.prepare('DELETE FROM custom_category_channels WHERE category_id = ?').run(id)
        db.prepare('DELETE FROM custom_categories WHERE id = ? AND username = ?').run(id, username)
      })()
    },

    addChannelToCategory(username: string, id: number, channel: ChannelRef): void {
      const db = requireDb()
      if (!categoryById(db, username, id)) throw new PrefsError('That category does not exist')
      const kind = validateKind(channel.kind)
      const streamId = validateStreamId(channel.streamId)
      const name = cleanName(channel.name, 'name', MAX_NAME_LENGTH)
      const position =
        ((db.prepare('SELECT MAX(position) AS max FROM custom_category_channels WHERE category_id = ?').get(id) as { max: number | null }).max ?? -1) + 1
      db.prepare(
        `INSERT INTO custom_category_channels (category_id, kind, stream_id, name, source_category, position)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (category_id, kind, stream_id)
         DO UPDATE SET name = excluded.name, source_category = excluded.source_category`
      ).run(id, kind, streamId, name, channel.category ?? null, position)
    },

    removeChannelFromCategory(username: string, id: number, kind: MediaKind, streamId: number): void {
      const db = requireDb()
      if (!categoryById(db, username, id)) throw new PrefsError('That category does not exist')
      db.prepare('DELETE FROM custom_category_channels WHERE category_id = ? AND kind = ? AND stream_id = ?').run(
        id,
        validateKind(kind),
        validateStreamId(streamId)
      )
    }
  }
}

import Database from 'better-sqlite3'
import { existsSync, mkdirSync, readFileSync, renameSync } from 'fs'
import { dirname, join } from 'path'

// One SQLite database for everything the app persists, replacing the single JSON "flat file"
// that accounts used to live in. SQLite buys what the flat file could not offer: real
// transactions (a write can no longer be interrupted into a half-valid file), no
// read-modify-rewrite of the entire file per login, and a place for the per-user data the app
// now keeps — favourites, watch history, and custom categories — without inventing a second
// format. The file lives under DATA_DIR (/appdata in Docker), so it survives image updates
// exactly like the old file did.
//
// WAL mode is deliberate: readers never block the writer, which matters because the EPG tab
// polls while someone may be toggling a favourite.

export interface DbHandle {
  db: Database.Database
  path: string
  close: () => void
}

export function openDatabase(dataDir: string): DbHandle {
  const path = join(dataDir, 'allison.db')
  mkdirSync(dirname(path), { recursive: true })
  const db = new Database(path)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  createSchema(db)
  migrateFlatFile(db, dataDir)
  return { db, path, close: () => db.close() }
}

function createSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      username          TEXT PRIMARY KEY,
      role              TEXT NOT NULL,
      created_at        TEXT NOT NULL,
      last_login_at     TEXT,
      password_salt     TEXT NOT NULL,
      password_hash     TEXT NOT NULL,
      -- Encrypted (AES-256-GCM, see sessionStore.ts) Xtream credentials blob, exactly as the
      -- flat file stored it — only the container changed, not the protection.
      iptv_credentials  TEXT
    );

    CREATE TABLE IF NOT EXISTS favourites (
      username   TEXT NOT NULL,
      kind       TEXT NOT NULL,
      stream_id  INTEGER NOT NULL,
      name       TEXT NOT NULL,
      category   TEXT,
      added_at   TEXT NOT NULL,
      PRIMARY KEY (username, kind, stream_id)
    );

    -- Watch history. Name/category are denormalised on purpose: history should still make sense
    -- after the provider renumbers or drops a channel.
    CREATE TABLE IF NOT EXISTS history (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      username   TEXT NOT NULL,
      kind       TEXT NOT NULL,
      stream_id  INTEGER NOT NULL,
      name       TEXT NOT NULL,
      category   TEXT,
      watched_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS history_user_time ON history (username, watched_at DESC);

    CREATE TABLE IF NOT EXISTS custom_categories (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      username   TEXT NOT NULL,
      name       TEXT NOT NULL,
      position   INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      UNIQUE (username, name)
    );

    CREATE TABLE IF NOT EXISTS custom_category_channels (
      category_id     INTEGER NOT NULL REFERENCES custom_categories (id) ON DELETE CASCADE,
      kind            TEXT NOT NULL,
      stream_id       INTEGER NOT NULL,
      name            TEXT NOT NULL,
      source_category TEXT,
      position        INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (category_id, kind, stream_id)
    );

    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `)
}

/**
 * One-time import of the accounts flat file. Runs only when the database has no users yet and
 * users.json exists, and leaves the original in place as users.json.imported — an upgrade must
 * never be the moment someone's accounts disappear, and keeping the file means a rollback is
 * possible.
 */
function migrateFlatFile(db: Database.Database, dataDir: string): void {
  const flatFile = join(dataDir, 'users.json')
  const alreadyMigrated = db.prepare('SELECT value FROM meta WHERE key = ?').get('flat_file_migrated')
  if (alreadyMigrated || !existsSync(flatFile)) return
  const userCount = (db.prepare('SELECT COUNT(*) AS count FROM users').get() as { count: number }).count
  if (userCount > 0) return

  interface FlatUser {
    username?: unknown
    role?: unknown
    createdAt?: unknown
    lastLoginAt?: unknown
    password?: { salt?: unknown; hash?: unknown }
    iptvCredentials?: unknown
  }
  let parsed: { users?: FlatUser[] }
  try {
    parsed = JSON.parse(readFileSync(flatFile, 'utf8')) as { users?: FlatUser[] }
  } catch (err) {
    // A corrupt flat file is reported, not fatal: the app starts with an empty database and the
    // operator can decide what to do with the file (same posture as the rest of the app's
    // storage handling).
    console.error(`[db] could not read ${flatFile} for migration:`, err instanceof Error ? err.message : err)
    return
  }

  const insert = db.prepare(`
    INSERT OR REPLACE INTO users (username, role, created_at, last_login_at, password_salt, password_hash, iptv_credentials)
    VALUES (@username, @role, @createdAt, @lastLoginAt, @salt, @hash, @iptv)
  `)
  const insertMany = db.transaction((users: FlatUser[]) => {
    for (const user of users) {
      if (typeof user.username !== 'string' || typeof user.password?.salt !== 'string' || typeof user.password?.hash !== 'string') continue
      insert.run({
        username: user.username,
        role: user.role === 'admin' ? 'admin' : 'user',
        createdAt: typeof user.createdAt === 'string' ? user.createdAt : new Date().toISOString(),
        lastLoginAt: typeof user.lastLoginAt === 'string' ? user.lastLoginAt : null,
        salt: user.password.salt,
        hash: user.password.hash,
        iptv: typeof user.iptvCredentials === 'string' ? user.iptvCredentials : null
      })
    }
    db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('flat_file_migrated', new Date().toISOString())
  })

  try {
    insertMany(parsed.users ?? [])
    const migrated = (db.prepare('SELECT COUNT(*) AS count FROM users').get() as { count: number }).count
    renameSync(flatFile, `${flatFile}.imported`)
    console.log(`[db] migrated ${migrated} account(s) from users.json into ${join(dataDir, 'allison.db')} (original kept as users.json.imported)`)
  } catch (err) {
    console.error('[db] flat-file migration failed:', err instanceof Error ? err.message : err)
  }
}

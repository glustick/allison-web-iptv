import { randomBytes, scryptSync, timingSafeEqual } from 'crypto'
import type { Database } from 'better-sqlite3'
import { openDatabase } from './db.js'

// Persistent account store, now SQLite-backed (see db.ts for why the flat file was replaced).
// The public interface is deliberately unchanged from the JSON-file version, so nothing else in
// the server had to learn a new shape — the container changed, not the contract.

export type UserRole = 'admin' | 'user'

export const USER_ROLES: readonly UserRole[] = ['admin', 'user']

const USERNAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{2,31}$/
const MIN_PASSWORD_LENGTH = 6

export interface StoredUser {
  username: string
  role: UserRole
  createdAt: string
  lastLoginAt: string | null
  password: { salt: string; hash: string }
  iptvCredentials: string | null
}

export interface PublicUser {
  username: string
  role: UserRole
  createdAt: string
  lastLoginAt: string | null
}

export interface NewUserInput {
  username: string
  password: string
  role: UserRole
}

interface UserRow {
  username: string
  role: string
  created_at: string
  last_login_at: string | null
  password_salt: string
  password_hash: string
  iptv_credentials: string | null
}

function hashPassword(password: string): { salt: string; hash: string } {
  const salt = randomBytes(16).toString('hex')
  const hash = scryptSync(password, salt, 64).toString('hex')
  return { salt, hash }
}

function verifyPassword(password: string, stored: { salt: string; hash: string }): boolean {
  try {
    const expected = Buffer.from(stored.hash, 'hex')
    const actual = scryptSync(password, stored.salt, expected.length)
    return expected.length === actual.length && timingSafeEqual(expected, actual)
  } catch {
    return false
  }
}

export class UserStoreError extends Error {
  /**
   * True when the database itself is unusable rather than the request being wrong. The
   * distinction matters beyond wording: a client mistake is a 4xx, but a storage outage is a 5xx,
   * and that is what an uptime check or a log watcher can act on.
   */
  readonly storageUnavailable: boolean

  constructor(message: string, storageUnavailable = false) {
    super(message)
    this.name = 'UserStoreError'
    this.storageUnavailable = storageUnavailable
  }
}

export interface UsersStore {
  hasUsers(): boolean
  listUsers(): PublicUser[]
  findUser(username: string): PublicUser | null
  verifyCredentials(username: string, password: string): StoredUser | null
  createUser(input: NewUserInput): PublicUser
  deleteUser(username: string): PublicUser
  /** Replaces a user's password (admin reset / self-service change). */
  setPassword(username: string, password: string): void
  countAdmins(): number
  recordLogin(username: string): void
  getIptvCredentials(username: string): string | null
  setIptvCredentials(username: string, encrypted: string | null): void
  // Boot-time diagnostic: verifies the database parses and the data directory is writable —
  // surfaces mount/permission mistakes in `docker logs` instead of as runtime 500s.
  /** Read-only: is the database open and queryable? Safe without a session. */
  status(): { ok: boolean; error?: string }
  /** Also proves the file is *writable* — one indexed write. Admin-facing. */
  healthCheck(): { ok: true } | { ok: false; error: string }
}

export function validateUsername(username: unknown): string {
  if (typeof username !== 'string') throw new UserStoreError('Username is required')
  const trimmed = username.trim()
  if (!USERNAME_PATTERN.test(trimmed)) {
    throw new UserStoreError('Username must be 3-32 characters: letters, numbers, dots, dashes or underscores')
  }
  return trimmed
}

export function validatePassword(password: unknown): string {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    throw new UserStoreError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`)
  }
  return password
}

export function validateRole(role: unknown): UserRole {
  if (role !== 'admin' && role !== 'user') throw new UserStoreError('Role must be "admin" or "user"')
  return role
}

function toPublic(row: UserRow): PublicUser {
  return {
    username: row.username,
    role: row.role === 'admin' ? 'admin' : 'user',
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at
  }
}

export function createUsersStore({ dataDir }: { dataDir: string }): UsersStore {
  // Opening can fail (corrupt file, unwritable volume). That must not stop the server from
  // booting — every method reports a readable error instead, the same posture the rest of the
  // app's storage handling takes.
  let handle: { db: Database; close: () => void } | null = null
  let openError: string | null = null
  try {
    handle = openDatabase(dataDir)
  } catch (err) {
    openError = err instanceof Error ? err.message : String(err)
  }

  /**
   * Cheap, read-only health. Unlike healthCheck() below this performs no write, so it is safe to
   * call from the *unauthenticated* health endpoint — which is the only thing an outside observer
   * (or an uptime check) can reach when the database is broken, and therefore the only way to tell
   * an unusable deployment apart from a healthy one without credentials.
   */
  function status(): { ok: boolean; error?: string } {
    if (!handle) return { ok: false, error: openError ?? 'database could not be opened' }
    try {
      handle.db.prepare('SELECT 1').get()
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  function requireDb(): Database {
    if (!handle) throw new UserStoreError(`Account database is not usable: ${openError ?? 'unknown error'}`, true)
    return handle.db
  }

  function findRow(db: Database, username: string): UserRow | undefined {
    return db.prepare('SELECT * FROM users WHERE username = ?').get(username) as UserRow | undefined
  }

  return {
    status,

    hasUsers(): boolean {
      const db = requireDb()
      return (db.prepare('SELECT COUNT(*) AS count FROM users').get() as { count: number }).count > 0
    },

    listUsers(): PublicUser[] {
      const db = requireDb()
      const rows = db.prepare('SELECT * FROM users ORDER BY username COLLATE NOCASE').all() as UserRow[]
      return rows.map(toPublic)
    },

    findUser(username: string): PublicUser | null {
      const row = findRow(requireDb(), username)
      return row ? toPublic(row) : null
    },

    verifyCredentials(username: string, password: string): StoredUser | null {
      const row = findRow(requireDb(), username)
      if (!row) return null
      if (!verifyPassword(password, { salt: row.password_salt, hash: row.password_hash })) return null
      return {
        username: row.username,
        role: row.role === 'admin' ? 'admin' : 'user',
        createdAt: row.created_at,
        lastLoginAt: row.last_login_at,
        password: { salt: row.password_salt, hash: row.password_hash },
        iptvCredentials: row.iptv_credentials
      }
    },

    createUser(input: NewUserInput): PublicUser {
      const db = requireDb()
      const username = validateUsername(input.username)
      const password = validatePassword(input.password)
      const role = validateRole(input.role)
      if (findRow(db, username)) throw new UserStoreError(`User "${username}" already exists`)
      const { salt, hash } = hashPassword(password)
      const row: UserRow = {
        username,
        role,
        created_at: new Date().toISOString(),
        last_login_at: null,
        password_salt: salt,
        password_hash: hash,
        iptv_credentials: null
      }
      db.prepare(
        `INSERT INTO users (username, role, created_at, last_login_at, password_salt, password_hash, iptv_credentials)
         VALUES (@username, @role, @created_at, @last_login_at, @password_salt, @password_hash, @iptv_credentials)`
      ).run(row)
      return toPublic(row)
    },

    deleteUser(username: string): PublicUser {
      const db = requireDb()
      const row = findRow(db, username)
      if (!row) throw new UserStoreError(`User "${username}" does not exist`)
      const admins = (db.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin'").get() as { count: number }).count
      if (row.role === 'admin' && admins <= 1) throw new UserStoreError('Cannot delete the last remaining admin')
      // Custom categories cascade to their channels (see the schema's ON DELETE CASCADE); the
      // user's favourites and history go with them.
      db.transaction(() => {
        db.prepare('DELETE FROM custom_categories WHERE username = ?').run(username)
        db.prepare('DELETE FROM favourites WHERE username = ?').run(username)
        db.prepare('DELETE FROM history WHERE username = ?').run(username)
        db.prepare('DELETE FROM resume_positions WHERE username = ?').run(username)
        db.prepare('DELETE FROM users WHERE username = ?').run(username)
      })()
      return toPublic(row)
    },

    setPassword(username: string, password: string): void {
      const db = requireDb()
      const validated = validatePassword(password)
      if (!findRow(db, username)) throw new UserStoreError(`User "${username}" does not exist`)
      const { salt, hash } = hashPassword(validated)
      db.prepare('UPDATE users SET password_salt = ?, password_hash = ? WHERE username = ?').run(salt, hash, username)
    },

    countAdmins(): number {
      const db = requireDb()
      return (db.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin'").get() as { count: number }).count
    },

    recordLogin(username: string): void {
      const db = requireDb()
      db.prepare('UPDATE users SET last_login_at = ? WHERE username = ?').run(new Date().toISOString(), username)
    },

    getIptvCredentials(username: string): string | null {
      return findRow(requireDb(), username)?.iptv_credentials ?? null
    },

    setIptvCredentials(username: string, encrypted: string | null): void {
      const db = requireDb()
      if (!findRow(db, username)) throw new UserStoreError(`User "${username}" does not exist`)
      db.prepare('UPDATE users SET iptv_credentials = ? WHERE username = ?').run(encrypted, username)
    },

    healthCheck(): { ok: true } | { ok: false; error: string } {
      if (!handle) return { ok: false, error: openError ?? 'database could not be opened' }
      try {
        const db = handle.db
        db.prepare('SELECT COUNT(*) AS count FROM users').get()
        // Prove the file is actually writable, not merely readable.
        db.transaction(() => {
          db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('health_check', new Date().toISOString())
        })()
        return { ok: true }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  }
}

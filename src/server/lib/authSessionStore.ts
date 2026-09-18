/**
 * Sessions that survive a restart.
 *
 * They used to live only in a Map in memory, so every deploy — and every container recreate — signed
 * everyone out. That is not a security property, it is an accident of where the store was kept, and it
 * cost real time on 2026-09-17 when a sequence of releases meant signing in again after each one.
 *
 * Only the *hash* of a token is written, so a copy of the database cannot be turned into a working
 * session. The raw token still lives in the browser's HttpOnly cookie and in memory, which is all it
 * needs to.
 */
import { createHash } from 'node:crypto'
import { openDatabase } from './db.js'
import { decryptSecret, encryptSecret } from './sessionStore.js'

export interface StoredSession {
  username: string
  role: string
  loginAt: number
  lastSeenAt: number
}

export interface AuthSessionStore {
  save: (token: string, session: StoredSession) => void
  /** Throttled: a session's `lastSeenAt` is written at most once per `minIntervalMs`. */
  touch: (token: string, lastSeenAt: number, minIntervalMs?: number) => void
  remove: (token: string) => void
  removeForUser: (username: string) => void
  /**
   * Everything not idle-expired. Returns the *raw* token (decrypted) so the in-memory map can be
   * rebuilt exactly as it was, plus the hash for lookups. A row that cannot be decrypted is skipped
   * rather than taking the whole boot down with it.
   */
  load: (now: number) => { token: string; tokenHash: string; session: StoredSession }[]
  prune: (now: number) => number
  close: () => void
}

export function hashAuthToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export function createAuthSessionStore(options: { dataDir: string; ttlMs: number }): AuthSessionStore {
  const handle = openDatabase(options.dataDir)
  const insert = handle.db.prepare(
    'INSERT OR REPLACE INTO auth_sessions (token_hash, token_enc, username, role, login_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)'
  )
  const touch = handle.db.prepare(
    'UPDATE auth_sessions SET last_seen_at = ? WHERE token_hash = ? AND last_seen_at < ?'
  )
  const remove = handle.db.prepare('DELETE FROM auth_sessions WHERE token_hash = ?')
  const removeUser = handle.db.prepare('DELETE FROM auth_sessions WHERE username = ?')
  const select = handle.db.prepare(
    'SELECT token_hash AS tokenHash, token_enc AS tokenEnc, username, role, login_at AS loginAt, last_seen_at AS lastSeenAt FROM auth_sessions WHERE last_seen_at >= ?'
  )
  const prune = handle.db.prepare('DELETE FROM auth_sessions WHERE last_seen_at < ?')

  return {
    save(token, session) {
      insert.run(hashAuthToken(token), encryptSecret(token), session.username, session.role, session.loginAt, session.lastSeenAt)
    },
    touch(token, lastSeenAt, minIntervalMs = 60_000) {
      touch.run(lastSeenAt, hashAuthToken(token), lastSeenAt - minIntervalMs)
    },
    remove(token) {
      remove.run(hashAuthToken(token))
    },
    removeForUser(username) {
      removeUser.run(username)
    },
    load(now) {
      type Row = { tokenHash: string; tokenEnc: string; username: string; role: string; loginAt: number; lastSeenAt: number }
      const rows = select.all(now - options.ttlMs) as Row[]
      const out: { token: string; tokenHash: string; session: StoredSession }[] = []
      for (const row of rows) {
        let token: string
        try {
          token = decryptSecret(row.tokenEnc)
        } catch {
          // Written under a different SESSION_SECRET, or corrupted: unusable, and not worth failing
          // the whole boot over. The sweep will drop it once it is idle-expired.
          continue
        }
        out.push({ token, tokenHash: row.tokenHash, session: {
          username: row.username, role: row.role, loginAt: row.loginAt, lastSeenAt: row.lastSeenAt
        } })
      }
      return out
    },
    prune(now) {
      return prune.run(now - options.ttlMs).changes
    },
    close() {
      handle.close()
    }
  }
}

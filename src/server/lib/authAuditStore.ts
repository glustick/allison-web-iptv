// The durable half of the sign-in audit: the ring in authAudit.ts is useful for the session, but a
// deploy restarts the app, and "who signed in last week" is exactly the question an audit exists to
// answer. Bounded on insert so it cannot grow without limit; newest first when read.
//
// Takes a data directory and opens the database itself, like usersStore and prefsStore, rather than
// demanding a shared handle — SQLite in WAL mode is happy with a second connection to the same file.
import type { AuthAuditEntry, AuthAuditPersistence } from './authAudit.js'
import { openDatabase } from './db.js'

/** Rows kept. Older ones are dropped on insert rather than letting the table grow for ever. */
export const AUTH_AUDIT_LIMIT = 1000

export function createAuthAuditStore(options: { dataDir: string }): AuthAuditPersistence {
  const db = openDatabase(options.dataDir)
  const insert = db.db.prepare('INSERT INTO auth_audit (at, outcome, username, ip, user_agent) VALUES (?, ?, ?, ?, ?)')
  const trim = db.db.prepare('DELETE FROM auth_audit WHERE id NOT IN (SELECT id FROM auth_audit ORDER BY id DESC LIMIT ?)')
  const select = db.db.prepare(
    'SELECT at, outcome, username, ip, user_agent AS userAgent FROM auth_audit ORDER BY id DESC LIMIT ?'
  )
  // Case-insensitive on username: it is stored as typed at sign-in, and "Chris" must find "chris".
  const selectFor = db.db.prepare(
    'SELECT at, outcome, username, ip, user_agent AS userAgent FROM auth_audit WHERE lower(username) = lower(?) ORDER BY id DESC LIMIT ?'
  )
  // The admin log's filters (v0.102.0): each side optional, composed. The conditions and the
  // params are built together so a placeholder can never meet the wrong argument.
  const selectFiltered = db.db.prepare(
    'SELECT at, outcome, username, ip, user_agent AS userAgent FROM auth_audit WHERE lower(username) = lower(?) AND outcome = ? ORDER BY id DESC LIMIT ?'
  )
  const selectFilteredByUser = db.db.prepare(
    'SELECT at, outcome, username, ip, user_agent AS userAgent FROM auth_audit WHERE lower(username) = lower(?) ORDER BY id DESC LIMIT ?'
  )
  const selectFilteredByOutcome = db.db.prepare(
    'SELECT at, outcome, username, ip, user_agent AS userAgent FROM auth_audit WHERE outcome = ? ORDER BY id DESC LIMIT ?'
  )

  return {
    append(entry) {
      insert.run(entry.at, entry.outcome, entry.username, entry.ip, entry.userAgent)
      trim.run(AUTH_AUDIT_LIMIT)
    },
    recent(limit) {
      return select.all(limit) as AuthAuditEntry[]
    },
    recentFor(username, limit) {
      return selectFor.all(username, limit) as AuthAuditEntry[]
    },
    recentFiltered(filter) {
      if (filter.username && filter.outcome) {
        return selectFiltered.all(filter.username, filter.outcome, filter.limit) as AuthAuditEntry[]
      }
      if (filter.username) {
        return selectFilteredByUser.all(filter.username, filter.limit) as AuthAuditEntry[]
      }
      if (filter.outcome) {
        return selectFilteredByOutcome.all(filter.outcome, filter.limit) as AuthAuditEntry[]
      }
      return select.all(filter.limit) as AuthAuditEntry[]
    }
  }
}

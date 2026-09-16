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

  return {
    append(entry) {
      insert.run(entry.at, entry.outcome, entry.username, entry.ip, entry.userAgent)
      trim.run(AUTH_AUDIT_LIMIT)
    },
    recent(limit) {
      return select.all(limit) as AuthAuditEntry[]
    }
  }
}

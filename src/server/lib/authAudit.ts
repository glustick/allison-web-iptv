// Who signed in, when, from where — and who tried and failed.
//
// An audit trail is only useful if it survives the thing it is auditing: this app is restarted by
// every deploy, so the ring itself is in memory but each entry is *also* written to the container
// log, which is where you actually look afterwards. Usernames, IPs and user-agents only; never a
// password, never a token.
// 'password-changed'/'force-logout'/'user-created'/'user-deleted' record the admin actions that
// shape logins (v0.83.0) — a reset ends sessions, a deletion ends the account, and none of it
// was visible anywhere before the audit log gained its reader.
export type AuthOutcome =
  | 'ok'
  | 'failed'
  | 'locked'
  | 'logout'
  | 'setup'
  | 'revoked'
  | 'password-changed'
  | 'force-logout'
  // A viewer ending one of their own logins from the devices panel (v0.90.0) — distinct from
  // 'force-logout', which is an admin ending somebody else's.
  | 'session-ended'
  | 'user-created'
  | 'user-deleted'

export interface AuthAuditEntry {
  at: string
  outcome: AuthOutcome
  username: string
  ip: string
  userAgent: string
}

export interface AuthAudit {
  record(entry: Omit<AuthAuditEntry, 'at'> & { at?: Date }): void
  recent(limit?: number): AuthAuditEntry[]
  /**
   * One account's own trail (v0.90.0) — what the account-activity panel shows its owner. The
   * full trail stays admin-only; this is the same rows, filtered to the caller.
   */
  recentFor(username: string, limit?: number): AuthAuditEntry[]
  /**
   * The admin log's filters (v0.102.0): any combination of account and outcome, newest first.
   * Either side of the filter is optional — `recentFiltered({})` is `recent()` with a limit.
   */
  recentFiltered(filter: { username?: string; outcome?: AuthOutcome; limit?: number }): AuthAuditEntry[]
}

/** Where entries outlive the process. Optional, so the ring can be unit-tested on its own. */
export interface AuthAuditPersistence {
  append(entry: AuthAuditEntry): void
  recent(limit: number): AuthAuditEntry[]
  recentFor(username: string, limit: number): AuthAuditEntry[]
  recentFiltered(filter: { username?: string; outcome?: AuthOutcome; limit: number }): AuthAuditEntry[]
}

export function createAuthAudit(limit = 200, persistence?: AuthAuditPersistence): AuthAudit {
  const entries: AuthAuditEntry[] = []
  return {
    record(entry) {
      const at = (entry.at ?? new Date()).toISOString()
      const full: AuthAuditEntry = {
        at,
        outcome: entry.outcome,
        username: entry.username,
        ip: entry.ip,
        userAgent: entry.userAgent.slice(0, 200)
      }
      entries.push(full)
      // Newest last in memory, oldest dropped first — a fixed window, like the diagnostics ring.
      if (entries.length > limit) entries.splice(0, entries.length - limit)
      // The durable copy, when one is configured: the ring above dies with the process.
      try {
        persistence?.append(full)
      } catch (err) {
        console.error('[auth] could not persist an audit entry:', err instanceof Error ? err.message : String(err))
      }
      // The durable copy: container logs outlive any restart this app does.
      console.log(
        `[auth] ${full.outcome} user=${full.username} ip=${full.ip} ua=${JSON.stringify(full.userAgent.slice(0, 80))}`
      )
    },
    recent(count = 50) {
      const wanted = Math.max(1, Math.min(count, 500))
      if (persistence) {
        try {
          return persistence.recent(wanted)
        } catch (err) {
          console.error('[auth] could not read the audit trail:', err instanceof Error ? err.message : String(err))
        }
      }
      return entries.slice(-Math.min(wanted, entries.length || 1)).reverse()
    },
    recentFor(username, count = 20) {
      const wanted = Math.max(1, Math.min(count, 100))
      if (persistence) {
        try {
          return persistence.recentFor(username, wanted)
        } catch (err) {
          console.error('[auth] could not read the audit trail:', err instanceof Error ? err.message : String(err))
        }
      }
      // No durable copy: filter the ring. The ring is short (200), so the window this can look
      // back through is short too — an honest consequence of running without the store.
      return entries
        .filter((entry) => entry.username.toLowerCase() === username.toLowerCase())
        .slice(-wanted)
        .reverse()
    },
    recentFiltered(filter) {
      const wanted = Math.max(1, Math.min(filter.limit ?? 50, 500))
      if (persistence) {
        try {
          return persistence.recentFiltered({ ...filter, limit: wanted })
        } catch (err) {
          console.error('[auth] could not read the audit trail:', err instanceof Error ? err.message : String(err))
        }
      }
      return entries
        .filter(
          (entry) =>
            (!filter.username || entry.username.toLowerCase() === filter.username.toLowerCase()) &&
            (!filter.outcome || entry.outcome === filter.outcome)
        )
        .slice(-wanted)
        .reverse()
    }
  }
}

// Who signed in, when, from where — and who tried and failed.
//
// An audit trail is only useful if it survives the thing it is auditing: this app is restarted by
// every deploy, so the ring itself is in memory but each entry is *also* written to the container
// log, which is where you actually look afterwards. Usernames, IPs and user-agents only; never a
// password, never a token.
export type AuthOutcome = 'ok' | 'failed' | 'locked' | 'logout' | 'setup'

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
}

export function createAuthAudit(limit = 200): AuthAudit {
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
      // The durable copy: container logs outlive any restart this app does.
      console.log(
        `[auth] ${full.outcome} user=${full.username} ip=${full.ip} ua=${JSON.stringify(full.userAgent.slice(0, 80))}`
      )
    },
    recent(count = 50) {
      return entries.slice(-Math.max(1, Math.min(count, entries.length || 1))).reverse()
    }
  }
}

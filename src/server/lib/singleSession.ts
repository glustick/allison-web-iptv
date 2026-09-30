/**
 * One account, one active login — the operator's rule, in their words (2026-09-30): *"Only one
 * login per account should be active, the other stale logins should be automatically cleaned out."*
 *
 * Why the idle timeout could not do it on its own: a tab left open and playing sends an activity
 * heartbeat every ~15s, which *is* activity — so an abandoned login sitting on a channel never goes
 * idle, keeps its provider connection, and shows up in the admin console as still streaming. The
 * only honest way to retire it is a decision: when an account signs in, its other logins end.
 *
 * Pure over the session map it is handed, so the rule is unit-tested rather than buried in the
 * login route. The caller applies the consequences: memory, the SQLite session store, the proxy
 * target, and the audit entry.
 */

export interface SessionOwner {
  username: string
}

/**
 * Every token except `keepToken` that belongs to `username` — the logins a fresh sign-in retires.
 * Other accounts' sessions are never touched.
 */
export function revocableSessionTokens<T extends SessionOwner>(
  sessions: Iterable<[string, T]>,
  username: string,
  keepToken: string
): string[] {
  const tokens: string[] = []
  for (const [token, session] of sessions) {
    if (token !== keepToken && session.username === username) tokens.push(token)
  }
  return tokens
}

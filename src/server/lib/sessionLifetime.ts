// The absolute session lifetime cap (v0.104.0). The idle TTL (24h default) only ends sessions
// that go QUIET — and a tab left on a playing channel heartbeats every ~15 seconds, which IS
// activity, so an always-on viewer's login lives for ever. That is not a security property;
// it is an accident of what counts as activity. This cap is the other axis: however busy a
// session stays, it ends a bounded time after it began, and the viewer signs in again.
//
// Pure — the map-side checks in index.ts (the lazy lookup, the periodic sweep, the boot
// restore) pass their own clocks and TTLs in, which is what makes the expiry rules testable
// without waiting out a real day.


/** The default: a login is good for 30 days however active it stays. */
export const DEFAULT_MAX_SESSION_AGE_MS = 30 * 24 * 60 * 60 * 1000

/**
 * Reads AUTH_MAX_SESSION_AGE_HOURS. A finite positive number wins; anything else (unset, blank,
 * garbage, zero, negative) is the default — a typo must shorten nobody's sessions to nothing and
 * lengthen nobody's to forever.
 */
export function resolveMaxSessionAgeMs(raw: string | undefined): number {
  const hours = Number((raw ?? '').trim())
  if (!Number.isFinite(hours) || hours <= 0) return DEFAULT_MAX_SESSION_AGE_MS
  return hours * 60 * 60 * 1000
}

/** The shape both the in-memory session and a restored row share — enough to judge expiry. */
export interface SessionAges {
  loginAt: number
  lastSeenAt: number
}

/**
 * Whether a session has ended by TIME rather than by silence. The idle rule (idleTtlMs against
 * lastSeenAt) is the caller's own — this answers only the absolute question, so the two rules
 * compose without one knowing about the other.
 */
export function sessionIsExpired(
  now: number,
  session: SessionAges,
  maxAgeMs: number
): boolean {
  return now - session.loginAt > maxAgeMs
}

/** Convenience for the boot restore: which restored rows are past the cap. The row's session
 *  only needs the two ages — a StoredSession satisfies it, and so does anything shaped like it. */
export function expiredRestoredSessions(
  now: number,
  restored: Array<{ tokenHash: string; session: SessionAges }>,
  maxAgeMs: number
): Set<string> {
  const expired = new Set<string>()
  for (const row of restored) {
    if (sessionIsExpired(now, row.session, maxAgeMs)) expired.add(row.tokenHash)
  }
  return expired
}

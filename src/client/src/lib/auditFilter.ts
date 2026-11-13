// The Auth log's filters (v0.102.0). The admin audit endpoint takes an optional username and an
// optional outcome; this module owns the query string so the same validation rule — an outcome
// not in the known set asks for nothing rather than for everything — lives in one tested place
// instead of in the component.

/** Every outcome the server can record (mirrors AuthOutcome in the server's authAudit.ts). */
export const AUDIT_OUTCOMES = [
  'ok',
  'failed',
  'locked',
  'logout',
  'setup',
  'revoked',
  'password-changed',
  'force-logout',
  'session-ended',
  'user-created',
  'user-deleted'
] as const

export type AuditOutcome = (typeof AUDIT_OUTCOMES)[number]

/**
 * The query for /api/admin/audit. Empty inputs mean "no filter on that side" — the pair of empty
 * strings is the unfiltered log, exactly as it was before filters existed.
 */
export function auditFilterQuery(username: string, outcome: string, limit = 50): string {
  const params = new URLSearchParams()
  const user = username.trim()
  if (user.length > 0) params.set('username', user)
  // An unknown outcome is dropped rather than passed: the server would answer empty (it
  // validates too), and dropping it here keeps the select's "All" state honest.
  if ((AUDIT_OUTCOMES as readonly string[]).includes(outcome)) params.set('outcome', outcome)
  params.set('limit', String(limit))
  return params.toString()
}

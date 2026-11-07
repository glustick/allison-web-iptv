/**
 * One line per audit outcome, in the account-activity panel's language.
 *
 * The distinction that matters is not what the server called the event, but what it means to the
 * account's owner: a failed sign-in is somebody trying a password (or you mistyping one) and is
 * the row worth looking twice at; "revoked" is the one-login rule doing its job. Unknown outcomes
 * fall through to their raw name rather than to a comfortable euphemism.
 */
export type AuthOutcomeTone = 'ok' | 'warn' | 'bad' | 'neutral'

export interface AuthOutcomeLabel {
  label: string
  tone: AuthOutcomeTone
}

const LABELS: Record<string, AuthOutcomeLabel> = {
  ok: { label: 'Signed in', tone: 'ok' },
  failed: { label: 'Wrong password', tone: 'bad' },
  locked: { label: 'Locked out after failures', tone: 'warn' },
  logout: { label: 'Signed out', tone: 'neutral' },
  setup: { label: 'Account created', tone: 'neutral' },
  revoked: { label: 'Ended by a newer sign-in', tone: 'neutral' },
  'session-ended': { label: 'You ended this sign-in', tone: 'neutral' },
  'password-changed': { label: 'Password changed', tone: 'warn' },
  'force-logout': { label: 'Ended by an admin', tone: 'warn' },
  'user-created': { label: 'Account created', tone: 'neutral' },
  'user-deleted': { label: 'Account deleted', tone: 'bad' }
}

export function describeAuthOutcome(outcome: string): AuthOutcomeLabel {
  return LABELS[outcome] ?? { label: outcome, tone: 'neutral' }
}

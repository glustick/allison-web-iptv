/**
 * The change-password form's validation (v0.88.0), pure so the rules are pinned without a
 * browser. Mirrors the server's own minimum (usersStore's MIN_PASSWORD_LENGTH = 6) — the server
 * stays the authority; this exists so the form can say what's wrong before the round trip.
 */

export const MIN_PASSWORD_LENGTH = 6

/**
 * The first thing wrong with the form, or null when it may be submitted. Order matters: the
 * fields are checked in the order the user fills them, so the message names the earliest fix.
 */
export function validatePasswordChange(current: string, next: string, confirm: string): string | null {
  if (current.length === 0) return 'Enter your current password.'
  if (next.length < MIN_PASSWORD_LENGTH) return `The new password must be at least ${MIN_PASSWORD_LENGTH} characters.`
  if (next === current) return 'The new password must be different from the current one.'
  if (confirm !== next) return 'The two new-password fields do not match.'
  return null
}

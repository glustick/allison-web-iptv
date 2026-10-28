/**
 * The dead-session decision (v0.87.0), pure on purpose — the reviveOnVisible/sessionWatch
 * convention: the player owns the actions, this module owns the rules, and every gate is
 * unit-testable without a browser or an ffmpeg.
 *
 * Why this exists: when a transcode session's ffmpeg exits, the server knows in the same tick
 * (the exit handler removes the session from the live map) — but the player used to learn only
 * through hls.js's error ladder: each playlist refresh of the dead session 404s into a fatal
 * NETWORK_ERROR (hls.js does not retry 4xx), and the ladder spends its full four-retry budget
 * (~20 seconds, measured) before the session-replacement branch fires. Polling
 * /api/transcode/status while a session plays collapses that to one poll interval, and the
 * remedy is the one the ladder already applies: replace the session, say so, keep a budget.
 */

/** How often the player asks the server whether its session is still alive. */
export const SESSION_HEALTH_POLL_MS = 5000

/**
 * How many dead-session replacements one run of one channel may burn through before the
 * sentence: replacements beyond this look like the provider dropping the channel, not a blip.
 * (This budget finally has teeth — v0.74.0 declared "the third is terminal", but the counter
 * lived inside the attach effect, whose reloadTick dependency reset it on every successful
 * replacement, so the terminal branch was unreachable.)
 */
export const MAX_SESSION_REPLACEMENTS = 3

export interface DeadSessionVerdict {
  /** The server's answer for the session the player is running off. */
  alive: boolean
  /** Whether the player actually holds a transcode session (the poll is meaningless otherwise). */
  hasSession: boolean
  /** A fallback request already in flight — never double-fire the remedy. */
  awaiting: boolean
  /** Replacements this run has already burned. */
  replacements: number
}

/**
 * True when the player should replace its session NOW: the server says the session is dead,
 * the player really is running off one, nothing else is already restarting it, and the budget
 * holds. Every gate exists because its failure mode was a real bug: polling without a session
 * (direct playback) would 404-adjacent-loop; double-firing restartFallback starts two sessions
 * (two provider connections); and an unbounded budget loops forever on a dying provider.
 */
export function shouldRestartDeadSession(verdict: DeadSessionVerdict): boolean {
  if (verdict.alive) return false
  if (!verdict.hasSession) return false
  if (verdict.awaiting) return false
  return verdict.replacements < MAX_SESSION_REPLACEMENTS
}

/**
 * True when the budget is spent and the honest sentence replaces the retry: "the provider
 * appears to be dropping this channel". Same gates as shouldRestartDeadSession minus the
 * budget — the two functions are the fork at the end of the same verdict.
 */
export function isDeadSessionTerminal(verdict: DeadSessionVerdict): boolean {
  if (verdict.alive) return false
  if (!verdict.hasSession) return false
  if (verdict.awaiting) return false
  return verdict.replacements >= MAX_SESSION_REPLACEMENTS
}

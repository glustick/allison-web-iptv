// The always-on tab's self-healing (v0.84.0). When a deploy (or anything else that restarts
// the server) kills a session while the tab is hidden, the client recovery ladder exhausts
// itself into a terminal state and NOTHING retries without a click — measured 2026-10-25: an
// always-on Sky News tab sat dropped for 5+ hours after a container recreation, zero requests
// reaching the new server, because every terminal path is inert by design and no visibility or
// focus handler existed anywhere in the client. This module is the decision logic for healing
// that on the tab's return: a bounded auto-revive of terminal errors, and one immediate
// recovery kick for a merely-stalled stream. Pure on purpose — the LivePlayer owns the actions.

/** Auto-revives per playback. Three is deliberate: enough to ride out a deploy's restart
 *  window, few enough that tabbing in and out of a genuinely off-air channel cannot hammer
 *  the provider. Reset on successful playback (fragments flowing), like every other
 *  recovery counter in the player. */
export const MAX_AUTO_REVIVES = 3

export interface ReviveState {
  /** Any terminal state: fatal error shown, ladder gave up, not-broadcasting pause,
   *  session-keeps-ending. The states whose only way out was the Retry button. */
  terminal: boolean
  /** Auto-revives already spent since the last successful playback. */
  autoReviveAttempts: number
}

/** True when the tab's return should retry a terminal state automatically. */
export function shouldAutoRevive(state: ReviveState): boolean {
  return state.terminal && state.autoReviveAttempts < MAX_AUTO_REVIVES
}

export interface KickState {
  terminal: boolean
  /** A live player instance exists (not destroyed by a terminal path). */
  hasInstance: boolean
  /** The stream is behind (buffer starved / playhead stuck) — the state the 15s watchdog
   *  would eventually act on. */
  stalled: boolean
}

/** True when the tab's return should run ONE recovery pass immediately — the same pass the
 *  watchdog would run on its next tick, just without waiting up to 15s for a tab the browser
 *  had suspended. The watchdog keeps its job; this only shortens the wait. */
export function shouldKickRecovery(state: KickState): boolean {
  return !state.terminal && state.hasInstance && state.stalled
}

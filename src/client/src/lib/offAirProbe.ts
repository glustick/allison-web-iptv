// Off-air auto-resume (v0.110.0), ported from the desktop sibling's 0.31.0. The web player's
// not-broadcasting declaration (v0.74.0) was terminal until the viewer pressed Retry — honest
// about the connection, but a channel that starts broadcasting again an hour later stayed a
// black screen until a human noticed. This module is the cheap way back: while the channel sits
// declared off-air, fetch its playlist alone every OFF_AIR_PROBE_MS and ask one question — has
// the window moved? One playlist request per interval is a rounding error next to the ladder
// the declaration deliberately paused, and the probe stops the moment anything else happens.

/** How often an off-air channel is re-probed. */
export const OFF_AIR_PROBE_MS = 30_000

/** The most probes a run will make before returning to the manual Retry sentence: one hour.
 *  Bounded so an abandoned tab does not probe a dead channel for ever — the same discipline
 *  every other recovery loop here carries. */
export const MAX_OFF_AIR_PROBES = 120

export interface PlaylistWindow {
  startSN: number
  endSN: number
}

/**
 * The window out of a media playlist's own text: EXT-X-MEDIA-SEQUENCE plus the count of segment
 * lines. Null when the text is not a media playlist carrying segments (an error page, a master
 * playlist, or the provider's raw-TS flip) — a shape we cannot judge is a shape we do not act on.
 */
export function parsePlaylistWindow(text: string): PlaylistWindow | null {
  const match = /#EXT-X-MEDIA-SEQUENCE:(\d+)/.exec(text)
  if (!match) return null
  const segments = text.split('\n').filter((line) => line.length > 0 && !line.startsWith('#')).length
  if (segments === 0) return null
  const startSN = Number(match[1])
  return { startSN, endSN: startSN + segments - 1 }
}

/**
 * Whether a fresh window means the channel is broadcasting again: any movement — the end
 * advanced OR the window slid forward — is a signal. An IDENTICAL window is still the same
 * frozen placeholder the declaration measured.
 */
export function windowAdvanced(frozen: PlaylistWindow, fresh: PlaylistWindow): boolean {
  return fresh.endSN > frozen.endSN || fresh.startSN > frozen.startSN
}

/** One probe step's verdict. */
export type ProbeVerdict = 'resume' | 'keep-probing' | 'give-up'

/**
 * The probe loop's decision, pure over its counters: resume when the window moved, keep going
 * while probes remain, give up at the bound. `fresh` null (unparseable answer, a network error)
 * counts as keep-probing — one bad answer is not evidence of anything, and the bound holds the line.
 */
export function probeVerdict(frozen: PlaylistWindow, fresh: PlaylistWindow | null, probesSoFar: number): ProbeVerdict {
  if (fresh !== null && windowAdvanced(frozen, fresh)) return 'resume'
  if (probesSoFar >= MAX_OFF_AIR_PROBES) return 'give-up'
  return 'keep-probing'
}

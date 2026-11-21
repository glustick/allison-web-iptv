// Decides how to recover a live stream whose loader was wedged by page suspension — the
// failure found live on 2026-09-12 (see ROADMAP, "backgrounding the app permanently wedges
// Live TV"): when a browser tab / hosting webview is backgrounded, its timers are clamped and
// hls.js's live playlist-refresh chain stops; on return to the foreground nothing ever restarts
// it — zero new fragment requests, buffer exhausted at the playhead, no error anywhere, and
// only a channel switch or reload recovers. Deliberately a pure function (node-only vitest,
// same convention as connectionTiming.ts): the player only feeds it a snapshot and applies the
// verdicts, so every rule below is directly testable without a browser or an hls.js instance.

// A healthy live stream appends a fragment every segment duration (typically 2–10s, and even
// unusual 30s targets leave wide margin). 60s with zero fragments means the loader is not
// running — long enough that slow-but-alive providers don't false-positive, short enough that
// a wedged stream recovers within about a minute of the page becoming visible again.
export const LIVE_STALE_AFTER_MS = 60_000

// A *paused* element is judged against a much longer window, because pausing mid-buffer hides
// the starvation the 60s rule keys on: the playhead stops but the source keeps (not) loading,
// so "not at buffer end" stops meaning "healthy". Without this, a stream that stalled while
// the viewer had it paused is only noticed when they press play and the leftover buffer plays
// out — a guaranteed visible freeze that recovery then has to chase. Three minutes of zero
// fragments on a paused live stream means the source is dead no matter where the playhead
// sits; recovering in the background means it is healthy again by the time play is pressed.
export const LIVE_STALE_WHILE_PAUSED_MS = 180_000

// "Startup" stops being startup after this long with zero fragments ever appended. The rule
// below deliberately ignores a run that has never received a fragment (hls.js owns loading),
// but a source that produces nothing for 90s is not loading — it is dead, and without this
// escape the watchdog stays blind to it forever (found live: a dead transcode session leaves
// exactly this state after its network retries exhaust, and the player sits idle with no
// error and no recovery).
export const LIVE_STARTUP_ABANDON_MS = 90_000

export interface LiveStallSnapshot {
  now: number
  /** Timestamp of the last FRAG_BUFFERED, or null before the first fragment ever arrives. */
  lastFragmentAt: number | null
  /** When this player run was attached — bounds how long "startup" can last with no fragments. */
  runStartedAt: number
  /** True when the playhead sits at (or beyond) the end of the buffered range, or there is no buffer. */
  playheadAtBufferEnd: boolean
  /** True once the player has given up with an on-screen error — recovery is the error path's job then. */
  hasFatalError: boolean
  /** A stream that finished (VOD-shaped edge case) must not be "recovered". */
  ended: boolean
  /** A viewer-paused stream still has to keep loading (live never waits); see LIVE_STALE_WHILE_PAUSED_MS. */
  paused: boolean
  /** How many loader kicks have been applied since the last fragment arrived. */
  kicksSinceLastFragment: number
  /** Seconds of playable buffer ahead of the playhead (v0.117.0) — the triage the kick-vs-reload
   *  decision now uses, instead of guessing from the buffer's end alone. */
  bufferAheadSeconds: number
}

export interface LiveRecoveryActions {
  /** Call video.play() — covers the browser auto-pausing the element during suspension. */
  resumePlayback: boolean
  /** Call hls.startLoad() — restarts the wedged live-refresh/fragment loop. */
  kickLoader: boolean
  /** Tear the source down and re-attach it (the player's own reload path). */
  reloadSource: boolean
}

const NO_ACTIONS: LiveRecoveryActions = { resumePlayback: false, kickLoader: false, reloadSource: false }

export function liveRecoveryActions(snapshot: LiveStallSnapshot): LiveRecoveryActions {
  if (snapshot.hasFatalError || snapshot.ended) return NO_ACTIONS
  // Startup belongs to hls.js's own loading/error paths — but only for so long. A run that has
  // never appended a fragment past LIVE_STARTUP_ABANDON_MS is dead, not starting (see that
  // constant's comment); go straight to the reload ladder, since there is nothing to kick.
  if (snapshot.lastFragmentAt === null) {
    if (snapshot.now - snapshot.runStartedAt >= LIVE_STARTUP_ABANDON_MS) {
      return { resumePlayback: false, kickLoader: false, reloadSource: true }
    }
    return NO_ACTIONS
  }

  const age = snapshot.now - snapshot.lastFragmentAt
  // A buffer ahead of the playhead means fragments are still flowing or recently did while the
  // stream plays normally — unless the element is paused and the source has been dead for the
  // longer window, per LIVE_STALE_WHILE_PAUSED_MS above. (A user-paused live stream keeps
  // loading, so genuinely healthy paused streams never age out.)
  const starvedOrPausedStale = snapshot.playheadAtBufferEnd
    ? age >= LIVE_STALE_AFTER_MS
    : snapshot.paused && age >= LIVE_STALE_WHILE_PAUSED_MS
  if (!starvedOrPausedStale) return NO_ACTIONS

  // Two kicks that produced no fragments mean startLoad() is not enough — escalate to a full
  // source reload rather than kicking a dead loader forever.
  if (snapshot.kicksSinceLastFragment >= 2) {
    return { resumePlayback: false, kickLoader: false, reloadSource: true }
  }
  // v0.117.0 — the buffer-aware triage the desktop sibling shipped (its 0.30.0): with almost no
  // buffer left, a kick is a delay — the screen freezes before the kick can help, so the reload
  // ladder starts NOW instead of after two visible freezes. With buffer still playing, the kick
  // is harmless and the gentle rung goes first.
  if (snapshot.bufferAheadSeconds < BUFFER_EMPTY_SECONDS) {
    return { resumePlayback: false, kickLoader: false, reloadSource: true }
  }
  return { resumePlayback: !snapshot.paused, kickLoader: true, reloadSource: false }
}

/** Below this much buffer ahead, the screen is about to freeze — escalation over gentleness. */
export const BUFFER_EMPTY_SECONDS = 2

/** How far behind the live edge a playhead may drift before recovery drags it back. Far enough
 *  that a long pause-and-return never triggers it, close enough that "still watching" is true. */
export const LIVE_REJOIN_BEHIND_SECONDS = 45

/** The live-edge rejoin rung (v0.117.0, ported from the desktop's 0.30.0): a LIVE playhead that
 *  has drifted far behind hls.js's own sync position — while the buffer still plays fine, which
 *  is why the stale rules above stay silent — is not "watching" anymore; it is a slow slide to
 *  a buffer starved minutes from now. One seek to the edge fixes it. Never fires on paused
 *  elements (the viewer chose that position) or without a real sync position. */
export function shouldRejoinLiveEdge(snapshot: {
  paused: boolean
  currentTime: number
  liveSyncPosition: number | null
  bufferAheadSeconds: number
}): boolean {
  if (snapshot.paused) return false
  if (snapshot.liveSyncPosition === null) return false
  const behind = snapshot.liveSyncPosition - snapshot.currentTime
  return behind > LIVE_REJOIN_BEHIND_SECONDS && snapshot.bufferAheadSeconds > 0
}

/** The reconnect backoff (v0.117.0, ported from the desktop's 0.30.0): attempt 0 waits 2s,
 *  each further attempt doubles, capped at 15s — a flapping provider gets spaced retries
 *  instead of four identical 2s slams into the same wall. */
export function networkRetryDelayMs(attempt: number): number {
  const capped = Math.max(0, Math.min(attempt, 3))
  return Math.min(2_000 * 2 ** capped, 15_000)
}

/** The playhead-at-exhausted-buffer check the snapshot's `playheadAtBufferEnd` comes from. */
export function isPlayheadAtBufferEnd(video: { currentTime: number; buffered: { length: number; end: (i: number) => number } }): boolean {
  if (video.buffered.length === 0) return true
  return video.currentTime >= video.buffered.end(video.buffered.length - 1) - 0.5
}

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

export interface LiveStallSnapshot {
  now: number
  /** Timestamp of the last FRAG_BUFFERED, or null before the first fragment ever arrives. */
  lastFragmentAt: number | null
  /** True when the playhead sits at (or beyond) the end of the buffered range, or there is no buffer. */
  playheadAtBufferEnd: boolean
  /** True once the player has given up with an on-screen error — recovery is the error path's job then. */
  hasFatalError: boolean
  /** A stream that finished (VOD-shaped edge case) must not be "recovered". */
  ended: boolean
  /** How many loader kicks have been applied since the last fragment arrived. */
  kicksSinceLastFragment: number
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
  // Startup (no fragment yet) belongs to hls.js's own loading/error paths, not this watchdog.
  if (snapshot.lastFragmentAt === null) return NO_ACTIONS

  const stale = snapshot.now - snapshot.lastFragmentAt >= LIVE_STALE_AFTER_MS
  if (!stale) return NO_ACTIONS

  // A buffer ahead of the playhead means fragments are still flowing or recently did while the
  // user simply has the stream paused — nothing to kick. (A user-paused live stream keeps
  // loading, so it doesn't go stale in the first place.)
  const starved = snapshot.playheadAtBufferEnd
  if (!starved) return NO_ACTIONS

  // Two kicks that produced no fragments mean startLoad() is not enough — escalate to a full
  // source reload rather than kicking a dead loader forever.
  if (snapshot.kicksSinceLastFragment >= 2) {
    return { resumePlayback: true, kickLoader: false, reloadSource: true }
  }
  return { resumePlayback: true, kickLoader: true, reloadSource: false }
}

/** The playhead-at-exhausted-buffer check the snapshot's `playheadAtBufferEnd` comes from. */
export function isPlayheadAtBufferEnd(video: { currentTime: number; buffered: { length: number; end: (i: number) => number } }): boolean {
  if (video.buffered.length === 0) return true
  return video.currentTime >= video.buffered.end(video.buffered.length - 1) - 0.5
}

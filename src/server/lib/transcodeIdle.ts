// Deciding when a transcode session has lost its viewer.
//
// Reported live: "I have stopped streaming but I see that the transcoding is continuing, the
// directory is growing, but I am not streaming anything." Correct — nothing did stop it. A
// session is only ended when the client asks (POST /api/transcode/stop, sent when the player
// switches channel or source), so a client that simply vanishes — tab closed, page reloaded,
// another tab opened, laptop lid shut, container restarted under it — leaves ffmpeg writing
// segments for ever. Worse than the wasted disk: a live transcode holds one of the account's two
// provider connections, so orphans can starve real playback.
//
// The client now also stops its session on unmount and beacons a stop when the page goes away,
// but a client cannot be trusted to report its own disappearance — the server has to notice, from
// the only signal it has: whether anyone is still asking for the output.

export interface IdleSessionView {
  /** Whether the playlist exists yet — see sessionIsIdle's own note on why this gates the check. */
  hasPlaylist: boolean
  /** When the session last served output to a client (its start time until the first request). */
  lastServedAt: number
}

/**
 * Whether a session has no viewer left.
 *
 * Deliberately gated on the playlist existing: the client sits on POST /api/transcode/start until
 * the playlist appears, which legitimately takes up to 45s for live and up to 240s for VOD, with
 * no request to this server in between. Reaping on idleness alone would kill exactly the slow
 * starts that the start deadlines exist to allow. Once there *is* a playlist the viewer is
 * fetching segments every few seconds, so silence means they are gone.
 */
export function sessionIsIdle(nowMs: number, session: IdleSessionView, idleStopMs: number): boolean {
  if (!session.hasPlaylist) return false
  if (!Number.isFinite(idleStopMs) || idleStopMs <= 0) return false
  return nowMs - session.lastServedAt >= idleStopMs
}

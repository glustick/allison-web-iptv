// Whether a programme in the guide can be played from the provider's archive, and what to ask for.
//
// The provider flags which channels have catch-up (`tv_archive`) and how far back it goes
// (`tv_archive_duration`); the guide already renders past programmes, but clicking one played the
// *live* channel, which is why this was invisible rather than wrong-looking.
export interface CatchupRequest {
  startSeconds: number
  durationMinutes: number
}

export interface CatchupChannel {
  tv_archive?: number
  tv_archive_duration?: number
}

export interface CatchupProgramme {
  startMs: number
  stopMs: number
}

/**
 * The catch-up request for a programme, or null when there is none.
 *
 * `tv_archive_duration` is conventionally **days** in Xtream panels (7, 14, 30), so it is read that
 * way here; if a provider means hours, the worst case is that this offers a programme the provider
 * then refuses, which surfaces as a playback error rather than as silence.
 *
 * In-progress programmes return null on purpose: the live stream is the better answer for those,
 * and a "restart this programme" feature should be its own affordance rather than a side effect of
 * clicking a block that is still running.
 */
export function catchupForProgramme(
  channel: CatchupChannel,
  programme: CatchupProgramme,
  nowMs: number
): CatchupRequest | null {
  if (channel.tv_archive !== 1) return null
  if (!Number.isFinite(programme.startMs) || !Number.isFinite(programme.stopMs)) return null
  if (programme.stopMs > nowMs) return null

  const archiveDays = Number.isFinite(channel.tv_archive_duration) ? Number(channel.tv_archive_duration) : 0
  if (archiveDays <= 0) return null
  const archiveMs = archiveDays * 24 * 60 * 60 * 1000
  if (nowMs - programme.startMs > archiveMs) return null

  const durationMinutes = Math.max(1, Math.ceil((programme.stopMs - programme.startMs) / 60_000))
  return { startSeconds: Math.floor(programme.startMs / 1000), durationMinutes }
}

/**
 * Restarting a programme that is *still on air*, from its beginning.
 *
 * The archive can serve from any point inside its window, so the start of the current programme is
 * fair game — and for live sport that is the whole point ("I joined at half time"). It is the same
 * request as catch-up with now as the end, which is why it returns the same shape and reuses the
 * same transcoded path; only the affordance differs, because clicking a live programme should still
 * play the channel.
 */
export function restartRequestForProgramme(
  channel: CatchupChannel,
  programme: CatchupProgramme,
  nowMs: number
): CatchupRequest | null {
  if (channel.tv_archive !== 1) return null
  if (!Number.isFinite(programme.startMs) || !Number.isFinite(programme.stopMs)) return null
  // Only meaningful for something still running: a finished programme is ordinary catch-up.
  if (programme.stopMs <= nowMs) return null
  if (programme.startMs > nowMs) return null

  const archiveDays = Number.isFinite(channel.tv_archive_duration) ? Number(channel.tv_archive_duration) : 0
  if (archiveDays <= 0) return null
  if (nowMs - programme.startMs > archiveDays * 24 * 60 * 60 * 1000) return null

  // From the programme's start up to now — however long ago that was, inside the archive window.
  const durationMinutes = Math.max(1, Math.ceil((nowMs - programme.startMs) / 60_000))
  return { startSeconds: Math.floor(programme.startMs / 1000), durationMinutes }
}

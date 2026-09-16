// Catch-up (timeshift) playback: the provider keeps a bounded window of each channel it flags with
// `tv_archive`, and hands it back as a plain MPEG-TS stream starting from an arbitrary point inside
// that window. This builds the provider path for it.
//
// Deliberately one small, testable function: the exact path shape is a provider convention rather
// than something the panel advertises (get_live_streams reports only `tv_archive` and
// `tv_archive_duration`), so if a provider disagrees, this is the single place to correct.
// The conventional Xtream shape is:
//
//   /timeshift/<username>/<password>/<duration-minutes>/<YYYY-MM-DD:HH-MM>/<stream-id>.ts
//
// with the start timestamp in the provider's own clock — UTC for every panel seen so far, and the
// EPG's own timestamps are epoch-based, so UTC is what gets written here.
export interface TimeshiftCredentials {
  username: string
  password: string
}

/** Nobody's archive is longer than this; a wilder value is a bug or an abuse, not a request. */
export const TIMESHIFT_MAX_MINUTES = 7 * 24 * 60

export class TimeshiftRequestError extends Error {}

/** `YYYY-MM-DD:HH-MM`, in UTC — the form the provider's timeshift path expects. */
export function formatTimeshiftStart(startSeconds: number): string {
  const d = new Date(startSeconds * 1000)
  const p = (n: number): string => String(n).padStart(2, '0')
  return (
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}` +
    `:${p(d.getUTCHours())}-${p(d.getUTCMinutes())}`
  )
}

export function buildTimeshiftPath(
  credentials: TimeshiftCredentials,
  file: string,
  startSeconds: number,
  durationMinutes: number,
  nowSeconds = Math.floor(Date.now() / 1000)
): string {
  if (!/^[A-Za-z0-9_-]+\.ts$/.test(file)) {
    throw new TimeshiftRequestError('Unsupported catch-up path')
  }
  if (!Number.isFinite(startSeconds) || startSeconds < 1_500_000_000 || startSeconds > nowSeconds + 60) {
    // Refusing a start outside any plausible archive window keeps a typo from becoming a provider
    // request for a decade of video.
    throw new TimeshiftRequestError('Invalid catch-up start time')
  }
  if (!Number.isFinite(durationMinutes) || durationMinutes < 1 || durationMinutes > TIMESHIFT_MAX_MINUTES) {
    throw new TimeshiftRequestError('Invalid catch-up duration')
  }
  const minutes = Math.round(durationMinutes)
  return (
    `/timeshift/${encodeURIComponent(credentials.username)}/${encodeURIComponent(credentials.password)}` +
    `/${minutes}/${formatTimeshiftStart(startSeconds)}/${file}`
  )
}

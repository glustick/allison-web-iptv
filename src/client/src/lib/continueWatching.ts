/**
 * "Continue watching" — and, more importantly, when to stop saying it.
 *
 * The resume store records a position on every progress event, including the very last one, so
 * until now a film watched to the end sat in the list at 100% for ever. That is the bug this
 * module exists to fix: **finished is a state**, decided here once and used by both the shelf that
 * lists titles and the handler that writes positions.
 *
 * Two rules, because one is not enough:
 * - a proportion (95%), which is right for a two-hour film watched at speed;
 * - a tail (two minutes), which is right for someone who lets the credits run — but only for a
 *   long title. Applied to a five-minute clip, "two minutes left" would call it finished before it
 *   started, which is a bug worth a test.
 */
export const FINISHED_RATIO = 0.95
export const FINISHED_TAIL_SECONDS = 120
/** The tail rule only applies to a title long enough to have credits. */
export const TAIL_RULE_MIN_DURATION_SECONDS = 600

export interface ProgressEntry {
  positionSeconds: number
  durationSeconds: number | null
  updatedAt?: string
}

export function isFinished(positionSeconds: number, durationSeconds: number | null): boolean {
  if (typeof durationSeconds !== 'number' || !Number.isFinite(durationSeconds) || durationSeconds <= 0) return false
  const position = Number.isFinite(positionSeconds) ? Math.max(0, positionSeconds) : 0
  if (position >= durationSeconds) return true
  if (position / durationSeconds >= FINISHED_RATIO) return true
  return durationSeconds >= TAIL_RULE_MIN_DURATION_SECONDS && durationSeconds - position <= FINISHED_TAIL_SECONDS
}

/** 0–100, or null when the duration is unknown (a live-ish source) — never a fabricated bar. */
export function progressPercent(positionSeconds: number, durationSeconds: number | null): number | null {
  if (typeof durationSeconds !== 'number' || !Number.isFinite(durationSeconds) || durationSeconds <= 0) return null
  const ratio = Math.max(0, Math.min(1, positionSeconds / durationSeconds))
  return Math.round(ratio * 100)
}

/**
 * The titles worth offering, newest first: unfinished only, capped. A missing or unreadable
 * `updatedAt` sorts last rather than jumping to the front.
 */
export function continueWatching<T extends ProgressEntry>(entries: T[], limit = 8): T[] {
  return entries
    .filter((entry) => !isFinished(entry.positionSeconds, entry.durationSeconds))
    .slice()
    .sort((a, b) => timestamp(b.updatedAt) - timestamp(a.updatedAt))
    .slice(0, Math.max(0, limit))
}

function timestamp(value: string | undefined): number {
  const parsed = value ? Date.parse(value) : Number.NaN
  return Number.isFinite(parsed) ? parsed : 0
}

/** "1:02:03" / "12:34" — a position on a title's own timeline, not a time of day. */
export function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds))
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const rest = seconds % 60
  const pad = (value: number): string => String(value).padStart(2, '0')
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(rest)}` : `${pad(minutes)}:${pad(rest)}`
}

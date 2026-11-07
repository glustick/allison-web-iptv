/**
 * "Stop in 30 minutes" — the thing every television has and this app did not.
 *
 * The timer is a **deadline**, not a countdown that gets decremented: a timeout that decrements
 * drifts, pauses while the tab is throttled, and would be wrong by minutes after a phone has been
 * face-down for an hour. Storing `endsAt` means the arithmetic is the same before and after the
 * browser has suspended the page, and a reload rejoins the countdown instead of forgetting it.
 *
 * It is deliberately **per device and global to the app**, not per channel: the question "stop
 * watching in half an hour" is about the viewer's evening, not about one stream. A channel change
 * must not quietly cancel it — which is exactly what a per-player `useState` would have done, since
 * a new channel remounts the player.
 *
 * Expiry **closes playback** rather than pausing the element. Pausing a live channel would leave
 * hls.js refreshing a playlist and the server holding a provider connection for a viewer who is
 * asleep; closing is what a television's sleep timer does, and it releases the connection.
 */
export const SLEEP_PRESETS = [15, 30, 45, 60, 90] as const

export interface SleepTimer {
  /** What the viewer chose — shown in the panel so "45 min" does not become a bare timestamp. */
  minutes: number
  /** Epoch milliseconds. */
  endsAt: number
  /** Set when the deadline came from the schedule rather than a preset ("End of programme"). */
  label?: string
}

const KEY = 'iptv:sleep-timer'
/** A guard against a hand-edited stored value: nothing legitimate is longer than half a day. */
const MAX_MINUTES = 12 * 60

/** Null for anything that is not a sane positive duration — a bad request must not arm a timer. */
export function startSleepTimer(minutes: number, now: number = Date.now()): SleepTimer | null {
  if (!Number.isFinite(minutes) || minutes <= 0 || minutes > MAX_MINUTES) return null
  const whole = Math.round(minutes)
  return { minutes: whole, endsAt: now + whole * 60_000 }
}

/**
 * A deadline taken from the guide rather than from a preset (v0.93.0): "stop when this programme
 * ends". Same validation as a preset — the panel can only offer a programme that is already on air,
 * but a stored value is still checked, because the guide is not the only writer.
 */
export function startUntil(endsAt: number, now: number = Date.now(), label = 'End of programme'): SleepTimer | null {
  if (!Number.isFinite(endsAt) || endsAt <= now) return null
  if (endsAt > now + MAX_MINUTES * 60_000) return null
  return { minutes: Math.max(1, Math.round((endsAt - now) / 60_000)), endsAt, label }
}

/**
 * When the thing on screen will end (v0.94.0) — the film's own deadline, so "stop at the end" works
 * for a 95-minute feature without the viewer doing arithmetic. Speed is taken into account: at
 * 1.5x, forty minutes of film have twenty-six minutes left.
 */
export function endOfPlaybackDeadline(
  currentSeconds: number,
  durationSeconds: number | null,
  now: number = Date.now(),
  rate = 1
): number | null {
  if (typeof durationSeconds !== 'number' || !Number.isFinite(durationSeconds) || durationSeconds <= 0) return null
  const speed = Number.isFinite(rate) && rate > 0 ? rate : 1
  const remaining = Math.max(0, durationSeconds - Math.max(0, currentSeconds))
  return now + Math.round((remaining / speed) * 1000)
}

/** Whole seconds left, rounded up (so "1 second left" shows 0:01, not 0:00), never negative. */
export function remainingSeconds(timer: SleepTimer, now: number = Date.now()): number {
  return Math.max(0, Math.ceil((timer.endsAt - now) / 1000))
}

/** `1:04:59` past an hour, `09:59` below it — the same clock shape the resume badges use. */
export function formatCountdown(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds))
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const rest = seconds % 60
  const pad = (value: number): string => String(value).padStart(2, '0')
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(rest)}` : `${pad(minutes)}:${pad(rest)}`
}

/**
 * The stored timer, or null. A deadline that has already passed is **cleared, not returned**: a
 * timer that expired while the tab was closed must not fire the moment it reopens, ending playback
 * of a film someone just started.
 */
export function readSleepTimer(
  now: number = Date.now(),
  storage: Pick<Storage, 'getItem' | 'removeItem'> | null = safeStorage()
): SleepTimer | null {
  if (!storage) return null
  try {
    const raw = storage.getItem(KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<SleepTimer>
    const endsAt = parsed.endsAt
    const minutes = parsed.minutes
    const sane =
      typeof endsAt === 'number' &&
      Number.isFinite(endsAt) &&
      typeof minutes === 'number' &&
      Number.isFinite(minutes) &&
      minutes > 0 &&
      minutes <= MAX_MINUTES &&
      endsAt > now &&
      endsAt <= now + MAX_MINUTES * 60_000
    if (!sane) {
      storage.removeItem(KEY)
      return null
    }
    return {
      minutes: Math.round(minutes),
      endsAt,
      ...(typeof parsed.label === 'string' && parsed.label.trim() ? { label: parsed.label.trim().slice(0, 80) } : {})
    }
  } catch {
    return null
  }
}

export function saveSleepTimer(timer: SleepTimer, storage: Pick<Storage, 'setItem'> | null = safeStorage()): void {
  if (!storage) return
  try {
    storage.setItem(KEY, JSON.stringify(timer))
  } catch {
    // A full store is not worth failing playback over.
  }
}

export function clearSleepTimer(storage: Pick<Storage, 'removeItem'> | null = safeStorage()): void {
  if (!storage) return
  try {
    storage.removeItem(KEY)
  } catch {
    // Same: the in-memory timer is cleared by the caller regardless.
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

/**
 * "Tell me when this starts" — the bell on a future programme in the guide.
 *
 * A reminder is a **deadline**, like the sleep timer, and for the same reason: a timer that
 * decrements is wrong after a suspended tab, while `startMs` arithmetic is the same before and
 * after. What is stored is per device (`localStorage`) because it describes the screen you are
 * watching, not the account — and because a reminder is only useful on a device that is awake to
 * show it.
 *
 * The record carries `firedAt` so a reload cannot repeat a reminder, and the store prunes itself
 * of programmes that ended more than a grace period ago, so a missed reminder does not fire days
 * later at whoever opens the app next.
 */
export const REMINDERS_KEY = 'iptv:reminders'
/** Fired on every write so an open panel and the watcher re-read without polling each other. */
export const REMINDERS_EVENT = 'iptv:reminders-changed'

/** How long after a programme's end a reminder is still worth keeping in the list. */
const GRACE_MS = 5 * 60_000
/** How far ahead a reminder may fire. */
export const REMINDER_LEAD_MS = 60_000
const MAX_REMINDERS = 50

export interface Reminder {
  /** Stable across reloads: the channel plus the programme's own start time. */
  id: string
  streamId: number
  /** Undefined (or '') for the primary playlist. */
  playlistId?: string
  channelName: string
  title: string
  startMs: number
  stopMs: number
  /** 0 until it has fired; then the moment it did. */
  firedAt: number
}

export function reminderId(streamId: number, playlistId: string | undefined, startMs: number): string {
  return `${playlistId ?? ''}:${streamId}:${startMs}`
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

/**
 * Everything still worth showing: not yet over (plus the grace period), well-formed, newest
 * first. A record whose programme ended long ago is dropped rather than kept as history — the
 * guide is where history belongs.
 */
export function pruneReminders(list: Reminder[], now: number): Reminder[] {
  return list
    .filter((reminder) => Number.isFinite(reminder.startMs) && Number.isFinite(reminder.stopMs))
    .filter((reminder) => reminder.stopMs + GRACE_MS > now)
    .sort((a, b) => a.startMs - b.startMs)
    .slice(0, MAX_REMINDERS)
}

export function upsertReminder(list: Reminder[], next: Reminder, now: number): Reminder[] {
  const without = list.filter((reminder) => reminder.id !== next.id)
  return pruneReminders([...without, next], now)
}

export function dropReminder(list: Reminder[], id: string): Reminder[] {
  return list.filter((reminder) => reminder.id !== id)
}

/**
 * Reminders that should fire now: within the lead window and not yet fired, and not for a
 * programme that has already ended (a reminder missed by days is noise, not news).
 */
export function dueReminders(list: Reminder[], now: number, leadMs: number = REMINDER_LEAD_MS): Reminder[] {
  return list.filter(
    (reminder) => reminder.firedAt === 0 && now >= reminder.startMs - leadMs && now < reminder.stopMs
  )
}

export function markFired(list: Reminder[], id: string, now: number): Reminder[] {
  return list.map((reminder) => (reminder.id === id ? { ...reminder, firedAt: now } : reminder))
}

export function readReminders(now: number = Date.now(), storage: Pick<Storage, 'getItem'> | null = safeStorage()): Reminder[] {
  if (!storage) return []
  try {
    const raw = storage.getItem(REMINDERS_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    const cleaned = parsed.filter((entry): entry is Reminder => {
      if (!entry || typeof entry !== 'object') return false
      const candidate = entry as Partial<Reminder>
      return (
        typeof candidate.id === 'string' &&
        typeof candidate.streamId === 'number' &&
        typeof candidate.title === 'string' &&
        typeof candidate.channelName === 'string' &&
        typeof candidate.startMs === 'number' &&
        typeof candidate.stopMs === 'number'
      )
    }).map((entry) => ({ ...entry, firedAt: typeof entry.firedAt === 'number' ? entry.firedAt : 0 }))
    return pruneReminders(cleaned, now)
  } catch {
    return []
  }
}

export function writeReminders(list: Reminder[], storage: Pick<Storage, 'setItem'> | null = safeStorage()): void {
  if (storage) {
    try {
      storage.setItem(REMINDERS_KEY, JSON.stringify(list))
    } catch {
      // A full store is not worth failing the guide over.
    }
  }
  // Announced even when storage is unavailable: an in-memory listener still wants to know.
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(REMINDERS_EVENT))
}

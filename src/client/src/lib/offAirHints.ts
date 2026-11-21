// Health-informed attach (v0.117.0, ported from the desktop's 0.31.0 idea): when a channel was
// declared not-broadcasting moments ago, the next play attempt (this device or the other tab)
// should SAY so immediately and probe before it spends a provider connection on 30 seconds of
// black screen and ladder churn. The declaration already happened — this only remembers it,
// for ten minutes, per device (localStorage like every hint here).
//
// Deliberately NOT durable and NOT server-shared: a channel that was dead ten minutes ago is
// often alive now, and the off-air probe is the authority — this hint only shapes the first
// seconds of the attempt.

const KEY = 'iptv:off-air-hints'

/** How long a not-broadcasting declaration shapes the next attempt. */
export const OFF_AIR_HINT_TTL_MS = 10 * 60 * 1000

/** Bounded like every other hint store. */
const LIMIT = 100

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

interface Entry {
  url: string
  at: number
}

function read(storage: Pick<Storage, 'getItem'> | null, now: number = Date.now()): Entry[] {
  if (!storage) return []
  try {
    const raw = storage.getItem(KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter(
        (entry): entry is Entry =>
          typeof entry?.url === 'string' && typeof entry?.at === 'number' && Number.isFinite(entry.at)
      )
      .filter((entry) => now - entry.at < OFF_AIR_HINT_TTL_MS)
      .slice(0, LIMIT)
  } catch {
    return []
  }
}

export function rememberNotBroadcasting(url: string, now: number = Date.now(), storage: Pick<Storage, 'getItem' | 'setItem'> | null = safeStorage()): void {
  if (!url || !storage) return
  const next = [{ url, at: now }, ...read(storage).filter((entry) => entry.url !== url)].slice(0, LIMIT)
  try {
    storage.setItem(KEY, JSON.stringify(next))
  } catch {
    // A full or unavailable store is not worth failing the declaration over.
  }
}

/** True when this channel was declared not-broadcasting within the TTL — shape the attempt. */
export function wasRecentlyNotBroadcasting(url: string, now: number = Date.now(), storage: Pick<Storage, 'getItem'> | null = safeStorage()): boolean {
  return read(storage, now).some((entry) => entry.url === url)
}

export function clearNotBroadcasting(url: string, storage: Pick<Storage, 'getItem' | 'setItem'> | null = safeStorage()): void {
  if (!storage) return
  try {
    storage.setItem(KEY, JSON.stringify(read(storage).filter((entry) => entry.url !== url)))
  } catch {
    // Nothing the clear must succeed for.
  }
}

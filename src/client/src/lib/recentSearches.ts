/**
 * The last few things the viewer searched for, offered back when the field is empty.
 *
 * Per device and in `localStorage`, like every other convenience here: a search is a moment's
 * intent, not a fact about the account, and syncing it across a household would put someone
 * else's queries in front of you.
 *
 * Recorded only when a search is **acted on** — a result clicked or Enter pressed — never on the
 * debounced request. Recording every request would fill the list with prefixes ("sky", "sky s",
 * "sky sp") from one typing session, which is worse than no history at all.
 */
const KEY = 'iptv:recent-searches'
const MAX = 5
/** One character is a stray keystroke, not a search; the bar itself waits for two. */
const MIN_LENGTH = 2

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

export function readRecentSearches(
  storage: Pick<Storage, 'getItem'> | null = safeStorage()
): string[] {
  if (!storage) return []
  try {
    const raw = storage.getItem(KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((entry): entry is string => typeof entry === 'string')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length >= MIN_LENGTH)
      .slice(0, MAX)
  } catch {
    return []
  }
}

/**
 * Put a query at the top and return the new list. Case-insensitive dedupe, so "Sky Sports" and
 * "sky sports" are one entry and the newer spelling wins.
 */
export function rememberSearch(
  query: string,
  storage: Pick<Storage, 'getItem' | 'setItem'> | null = safeStorage()
): string[] {
  const trimmed = query.trim().replace(/\s+/g, ' ')
  if (trimmed.length < MIN_LENGTH) return readRecentSearches(storage)
  const existing = readRecentSearches(storage)
  const next = [trimmed, ...existing.filter((entry) => entry.toLowerCase() !== trimmed.toLowerCase())].slice(0, MAX)
  if (!storage) return existing
  try {
    storage.setItem(KEY, JSON.stringify(next))
  } catch {
    // A full store is not worth failing a search over — but it must not *claim* the query was
    // remembered either: the list this returns is what the panel will show, and a row that
    // disappears on the next reload is worse than no row.
    return existing
  }
  return next
}

export function clearRecentSearches(
  storage: Pick<Storage, 'removeItem'> | null = safeStorage()
): string[] {
  if (storage) {
    try {
      storage.removeItem(KEY)
    } catch {
      // Same.
    }
  }
  return []
}

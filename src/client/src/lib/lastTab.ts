/**
 * Open on the tab you were on (v0.93.0).
 *
 * A small courtesy with one rule: only the five *content* tabs are remembered. Admin and System are
 * links to separate pages, not tabs you live in, and restoring into one of them after a reload would
 * put a configuration screen in front of someone who wanted the television.
 */
export type PersistableTab = 'live' | 'movies' | 'series' | 'sports' | 'epg'

const KEY = 'iptv:last-tab'

export function isPersistableTab(value: unknown): value is PersistableTab {
  return value === 'live' || value === 'movies' || value === 'series' || value === 'sports' || value === 'epg'
}

export function readLastTab(storage: Pick<Storage, 'getItem'> | null = safeStorage()): PersistableTab | null {
  if (!storage) return null
  try {
    const raw = storage.getItem(KEY)
    return isPersistableTab(raw) ? raw : null
  } catch {
    return null
  }
}

export function writeLastTab(tab: string, storage: Pick<Storage, 'setItem'> | null = safeStorage()): void {
  if (!storage || !isPersistableTab(tab)) return
  try {
    storage.setItem(KEY, tab)
  } catch {
    // Ignore: landing on Live TV is a fine default.
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

/**
 * The channel you were last watching (v0.93.0) — offered back as a "Continue" chip, never started
 * automatically.
 *
 * Autoplay on open would be a surprise (and a provider connection) for anyone who opened the app to
 * browse; a chip is an offer. Stored per device, like the other viewing conveniences, and validated
 * on read because a provider's ids are not ours to trust from a hand-edited store.
 */
export interface LastChannel {
  streamId: number
  playlistId?: string
  name: string
  categoryId: string | null
}

const KEY = 'iptv:last-channel'

export function readLastChannel(storage: Pick<Storage, 'getItem'> | null = safeStorage()): LastChannel | null {
  if (!storage) return null
  try {
    const raw = storage.getItem(KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<LastChannel>
    if (typeof parsed.streamId !== 'number' || !Number.isFinite(parsed.streamId)) return null
    if (typeof parsed.name !== 'string' || !parsed.name.trim()) return null
    return {
      streamId: parsed.streamId,
      name: parsed.name.trim().slice(0, 200),
      ...(typeof parsed.playlistId === 'string' && parsed.playlistId ? { playlistId: parsed.playlistId } : {}),
      categoryId: typeof parsed.categoryId === 'string' ? parsed.categoryId : null
    }
  } catch {
    return null
  }
}

export function writeLastChannel(channel: LastChannel, storage: Pick<Storage, 'setItem'> | null = safeStorage()): void {
  if (!storage) return
  try {
    storage.setItem(KEY, JSON.stringify(channel))
  } catch {
    // A full store is not worth failing playback over.
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

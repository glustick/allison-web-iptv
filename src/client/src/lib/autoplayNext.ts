// Auto-play next episode (v0.114.0). The Next button (v0.95.0) made continuing a manual act;
// this is the same continuation, offered on a short countdown when an episode ends — per device,
// and OFF by default: starting the next episode costs a provider connection and presumes the
// viewer is still there, and neither is this app's call to make unprompted.

const KEY = 'iptv:autoplay-next'

/** How long the countdown banner runs before the next episode starts. */
export const AUTOPLAY_COUNTDOWN_SECONDS = 10

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

export function readAutoplayNext(storage: Pick<Storage, 'getItem'> | null = safeStorage()): boolean {
  if (!storage) return false
  try {
    return storage.getItem(KEY) === 'on'
  } catch {
    return false
  }
}

export function writeAutoplayNext(on: boolean, storage: Pick<Storage, 'setItem'> | null = safeStorage()): void {
  if (!storage) return
  try {
    storage.setItem(KEY, on ? 'on' : 'off')
  } catch {
    // A full or unavailable store is not worth failing playback over.
  }
}

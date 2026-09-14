// Reports "what is on screen right now" to the server so the admin console can show who is
// streaming what. Two paths on purpose:
// - a debounced immediate report when playback changes (admin sees channel flips fast),
// - a periodic keepalive every 15s while something is playing (also keeps the login's idle
//   timeout refreshed while the user is actively watching).
// Components call reportNowPlaying(title) on selection and reportNowPlaying(null) on unmount;
// rapid channel zapping coalesces into the debounce instead of hammering the server.

export type NowPlayingKind = 'live' | 'movie' | 'series'

const CHANGE_DEBOUNCE_MS = 2500
const KEEPALIVE_MS = 15000

let current: { title: string; kind: NowPlayingKind } | null = null
let debounceTimer: number | null = null
let keepaliveTimer: number | null = null

function send(): void {
  void fetch('/api/auth/activity', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nowPlaying: current })
  }).catch(() => {
    // Network hiccup — the next keepalive retries; nothing user-visible to do here.
  })
}

function ensureTimers(): void {
  if (keepaliveTimer === null) {
    keepaliveTimer = window.setInterval(send, KEEPALIVE_MS)
  }
}

export function reportNowPlaying(title: string | null, kind: NowPlayingKind = 'live'): void {
  current = title ? { title: title.slice(0, 200), kind } : null
  ensureTimers()

  if (current === null) {
    // Playback stopped (or the tab's content unmounted) — clear promptly, no debounce.
    if (debounceTimer !== null) {
      window.clearTimeout(debounceTimer)
      debounceTimer = null
    }
    send()
    return
  }

  if (debounceTimer !== null) window.clearTimeout(debounceTimer)
  debounceTimer = window.setTimeout(() => {
    debounceTimer = null
    send()
  }, CHANGE_DEBOUNCE_MS)
}

import { useEffect, useState } from 'react'

// Noticing that the app session has gone away *while* something is playing.
//
// A session ends whenever the server restarts (every deploy does that) or after 24h idle. The
// player does not notice: hls.js keeps refreshing its playlist, each refresh now answers 401, and
// the picture simply stops advancing — reported twice as "it keeps pausing", with nothing on
// screen to explain it. The user's only clue was that a manual Retry reloaded the page.
//
// So: while a player is mounted, ask the server whether the session is still good. Only a 401
// counts — a transient network failure is not an expired session.
export const SESSION_WATCH_INTERVAL_MS = 20_000

/** Only an explicit 401 means the session is gone; anything else (including offline) is not. */
export function sessionExpiredFromStatus(status: number): boolean {
  return status === 401
}

/** True once the session is gone, for as long as `active` and until the page is reloaded. */
export function useSessionExpired(active: boolean): boolean {
  const [expired, setExpired] = useState(false)

  useEffect(() => {
    if (!active || expired) return
    let cancelled = false
    const check = async (): Promise<void> => {
      try {
        const res = await fetch('/api/session')
        if (!cancelled && sessionExpiredFromStatus(res.status)) setExpired(true)
      } catch {
        // Offline, or the request never completed: not evidence of an expired session.
      }
    }
    const timer = setInterval(() => void check(), SESSION_WATCH_INTERVAL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [active, expired])

  return expired
}

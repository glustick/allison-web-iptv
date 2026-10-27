import { useEffect, useState } from 'react'

// The connection budget's client half (v0.85.0). The provider allows the account about two
// concurrent connections, and until now the multi-view surfaces could only say so as a standing
// hint — the live number (this stream, plus that tile, plus the film someone left playing)
// existed nowhere. /api/iptv/connections answers it from the server's own relay activity, and
// this module turns it into the toolbar's sentence and the picker's gate.
//
// The ceiling is deliberately a constant here, not panel data: "about 2" is the honest precision
// this household's provider has shown, and the sentence says "about" for that reason. Gating is a
// WARNING, never a block — the operator's standing design rule for this feature (warn and
// explain, let the human decide).

/** What this provider's account allows, in the precision we actually know it. */
export const CONNECTION_CEILING = 2

export interface ConnectionSnapshot {
  /** Streams actively relayed + running transcode sessions — the count to compare. */
  used: number
  streamCount: number
  transcodes: number
}

export interface ConnectionStatus {
  level: 'ok' | 'at' | 'over'
  text: string
}

/** The standing sentence — also the fallback whenever the live count is unknown. */
const STANDING_HINT = 'Each tile is a live connection — the provider allows about 2, so tiles beyond that may starve.'

export function connectionStatus(
  snapshot: ConnectionSnapshot | null,
  ceiling: number = CONNECTION_CEILING
): ConnectionStatus {
  if (!snapshot) return { level: 'ok', text: STANDING_HINT }
  const used = snapshot.used
  if (used > ceiling) {
    return {
      level: 'over',
      text: `${used} live connections in use — over the provider's limit of about ${ceiling}; tiles may be starving now.`
    }
  }
  if (used === ceiling) {
    return {
      level: 'at',
      text: `${used} live connections in use — at the provider's limit of about ${ceiling}; another tile may starve.`
    }
  }
  return {
    level: 'ok',
    text: `${used} live connection${used === 1 ? '' : 's'} in use — room for another tile.`
  }
}

/** True when adding one more stream would reach past the ceiling — the picker's warning gate. */
export function tileWouldExceed(
  snapshot: ConnectionSnapshot | null,
  ceiling: number = CONNECTION_CEILING
): boolean {
  return snapshot !== null && snapshot.used >= ceiling
}

/** Polls the live connection count while a surface that cares about it is mounted. Null until
 *  the first answer arrives (and forever on an unreachable endpoint) — the standing hint covers
 *  that case, so a 401 or a hiccup degrades to today's behaviour, never to an error. */
export function useConnectionCount(pollMs = 15_000): ConnectionSnapshot | null {
  const [snapshot, setSnapshot] = useState<ConnectionSnapshot | null>(null)

  useEffect(() => {
    let active = true
    const poll = (): void => {
      fetch('/api/iptv/connections')
        .then((res) => (res.ok ? res.json() : null))
        .then((body: { used?: number; streamCount?: number; transcodes?: number } | null) => {
          if (!active || !body || typeof body.used !== 'number') return
          // A later answer never overwrites a newer one with an older poll's shape.
          setSnapshot({
            used: body.used,
            streamCount: body.streamCount ?? body.used,
            transcodes: body.transcodes ?? 0
          })
        })
        .catch(() => {})
    }
    poll()
    const timer = setInterval(poll, pollMs)
    return () => {
      active = false
      clearInterval(timer)
    }
  }, [pollMs])

  return snapshot
}

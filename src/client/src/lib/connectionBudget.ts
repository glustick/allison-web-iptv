import { useEffect, useState } from 'react'
import type { MultiViewSlot } from './multiViewPrefs'

// The connection budget's client half (v0.85.0). The provider allows the account about two
// concurrent connections, and until now the multi-view surfaces could only say so as a standing
// hint — the live number (this stream, plus that tile, plus the film someone left playing)
// existed nowhere. /api/iptv/connections answers it from the server's own relay activity, and
// this module turns it into the toolbar's sentence and the picker's gate.
//
// v0.86.0: the ceiling stopped being a guess. The provider's own user_info.max_connections is
// captured per playlist at credential-save time (see Playlist.maxConnections), so when it is
// KNOWN the sentences say the number exactly and the picker BLOCKS a tile that would exceed the
// account's real limit (each tile is one genuine provider connection — the number came from the
// provider, not from us). When it is UNKNOWN, everything falls back to the v0.85.0 behaviour:
// "about 2" and a warning, never a block — you cannot enforce a number you invented.

/** The provider's own concurrent-stream limit per account ('' = the primary), when captured;
 *  null where the panel never answered — and null never gates anything. */
export type PlaylistLimits = Record<string, number | null>

/** The fallback ceiling when the provider never answered — always hedged as "about". */
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

/**
 * The toolbar's sentence. `knownCeiling` is the provider's own number for the account the
 * toolbar speaks about (the primary playlist's) when it is known, null when it is not: a known
 * number is stated exactly, an unknown one keeps the hedged v0.85.0 wording.
 */
export function connectionStatus(
  snapshot: ConnectionSnapshot | null,
  knownCeiling: number | null = null
): ConnectionStatus {
  const ceiling = knownCeiling ?? CONNECTION_CEILING
  const qualifier = knownCeiling === null ? 'about ' : ''
  if (!snapshot) {
    return knownCeiling === null
      ? { level: 'ok', text: STANDING_HINT }
      : { level: 'ok', text: `Each tile is a live connection — this account allows ${knownCeiling} concurrent streams.` }
  }
  const used = snapshot.used
  if (used > ceiling) {
    return {
      level: 'over',
      text: `${used} live connections in use — over the provider's limit of ${qualifier}${ceiling}; tiles may be starving now.`
    }
  }
  if (used === ceiling) {
    return {
      level: 'at',
      text: `${used} live connections in use — at the provider's limit of ${qualifier}${ceiling}; another tile may starve.`
    }
  }
  return {
    level: 'ok',
    text: `${used} live connection${used === 1 ? '' : 's'} in use — room for another tile.`
  }
}

/** The picker's per-row verdict for adding one more tile of a given account. */
export type TileGate = 'ok' | 'warn' | 'block'

/**
 * Whether another tile may be added, judged per account (v0.86.0). `sameAccountUsage` counts the
 * connections that account is ALREADY holding (its filled tiles — each a live connection), and
 * `knownCeiling` is that account's own provider-stated limit when captured:
 *
 * - **block** — the account's known limit is reached. Not a warning: the number came from the
 *   provider, and the tile would starve something that is already playing.
 * - **warn** — the limit is unknown but the global fallback is spent; the v0.85.0 warning shape.
 * - **ok** — room, as far as anything knows.
 */
export function tileGate(
  sameAccountUsage: number,
  knownCeiling: number | null,
  globalSnapshot: ConnectionSnapshot | null
): TileGate {
  if (knownCeiling !== null && sameAccountUsage >= knownCeiling) return 'block'
  if (knownCeiling === null && globalSnapshot !== null && globalSnapshot.used >= CONNECTION_CEILING) return 'warn'
  return 'ok'
}

/**
 * How many live connections one provider account is holding through the tile grid: every filled
 * slot whose playlist belongs to that account (undefined playlistId = the primary). The main
 * player is cleared while the grid is up, so the tiles are the whole story.
 */
export function accountTileUsage(slots: Array<MultiViewSlot | null>, playlistId?: string): number {
  return slots.filter((slot) => slot !== null && (slot.playlistId ?? '') === (playlistId ?? '')).length
}

/** True when adding one more stream would reach past the ceiling — the v0.85.0 warning gate,
 *  kept for surfaces that only ever warn (unknown-limit households). */
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

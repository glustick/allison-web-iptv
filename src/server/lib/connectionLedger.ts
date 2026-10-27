// Which streams are actively holding provider connections (v0.85.0). The provider allows the
// account about two concurrent connections, and every playing surface in this app — the main
// player, each multi-view tile, a film, a catch-up programme — is live traffic relayed through
// this server, so "how many connections are we using" is a question this server can answer for
// itself, without asking the provider's panel.
//
// The honest signal is request ACTIVITY, not open tabs: the relay is one-request-one-connection
// (agent:false — see the proxy's own note), so a stream only holds a provider connection while
// the player is actually fetching from it. A live playlist re-requests every few seconds; a
// paused player with a full buffer stops fetching and stops counting — which is exactly right.
// Stale entries are pruned lazily on read; there is no timer to own.

/** A playing stream stops fetching for this long → its entry no longer counts. Generous on
 *  purpose: a healthy player whose buffer is full goes quiet between segment bursts, and a
 *  window tighter than a buffer burst would flap the count. */
const DEFAULT_WINDOW_MS = 30_000

/** Bound on remembered keys — the LRU discipline the proxy's own playlist windows use. A stale
 *  flood (a scraper walking stream ids) cannot grow the map without limit. */
const DEFAULT_MAX_ENTRIES = 64

export interface ConnectionLedgerDeps {
  now?: () => number
  windowMs?: number
  maxEntries?: number
}

export interface ActiveConnection {
  /** The app-side stream path — the same key the routes record and segment Referers carry. */
  key: string
  /** Milliseconds since the last request for this stream. */
  idleMs: number
}

export interface ConnectionLedger {
  record(key: string): void
  /** Streams with activity inside the window, oldest activity last. Prunes as a side effect. */
  active(): ActiveConnection[]
}

export function createConnectionLedger(deps: ConnectionLedgerDeps = {}): ConnectionLedger {
  const now = deps.now ?? Date.now
  const windowMs = deps.windowMs ?? DEFAULT_WINDOW_MS
  const maxEntries = deps.maxEntries ?? DEFAULT_MAX_ENTRIES
  const entries = new Map<string, number>()

  return {
    record(key: string): void {
      if (!key) return
      // Delete-then-set keeps Map iteration order = recency order, which is what makes both the
      // LRU cap and the oldest-first listing free.
      entries.delete(key)
      entries.set(key, now())
      while (entries.size > maxEntries) {
        const oldest = entries.keys().next().value
        if (oldest === undefined) break
        entries.delete(oldest)
      }
    },

    active(): ActiveConnection[] {
      const current = now()
      for (const [key, at] of entries) {
        if (current - at >= windowMs) entries.delete(key)
      }
      return [...entries.entries()]
        .map(([key, at]) => ({ key, idleMs: current - at }))
        .sort((a, b) => a.key.localeCompare(b.key))
    }
  }
}

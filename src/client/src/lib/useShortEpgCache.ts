import { useCallback, useRef, useState } from 'react'
import type { Session } from './appAuth'
import { playlistRefOf, type ShortEpgProgram } from './types'
import { XtreamClient } from './xtreamClient'

const MAX_CONCURRENT_FETCHES = 4

// Ported from the desktop app's useAppStore.ts (loadShortEpg + its module-level queue) — a
// per-channel EPG fetch (get_short_epg) queued behind a small concurrency cap rather than
// fired for every visible row at once, which matters a lot here: without it, scrolling a large
// category's worth of rows into view (or worse, rendering "All") would fire potentially
// thousands of simultaneous requests at the server/provider instead of a steady trickle of 4.
//
// v0.78.0: the cache is keyed per composite channel (`<playlistRef>:<streamId>`), because
// stream ids are provider-scoped — the primary's 668 and a second playlist's 668 are different
// channels with different guides, and each fetches through its own playlist's scoped client so
// the server resolves the right provider.
export function useShortEpgCache(session: Session): {
  shortEpgByStream: Record<string, ShortEpgProgram[]>
  request: (channel: { stream_id: number; playlistId?: string }) => void
} {
  const [shortEpgByStream, setShortEpgByStream] = useState<Record<string, ShortEpgProgram[]>>({})
  const requestedRef = useRef(new Set<string>())
  const activeRef = useRef(0)
  const queueRef = useRef<Array<() => Promise<void>>>([])

  const pump = useCallback((): void => {
    if (activeRef.current >= MAX_CONCURRENT_FETCHES) return
    const next = queueRef.current.shift()
    if (!next) return
    activeRef.current += 1
    // next() already catches its own rejections internally (see request() below) and never
    // actually rejects — the extra .catch() here is purely to satisfy no-floating-promises,
    // which doesn't recognize a bare .finally() as a handled rejection path.
    next()
      .catch(() => {})
      .finally(() => {
        activeRef.current -= 1
        pump()
      })
  }, [])

  const request = useCallback(
    (channel: { stream_id: number; playlistId?: string }) => {
      const playlistRef = playlistRefOf(channel)
      // Same key convention as the server's listings: the primary's stream id is bare, a
      // non-primary channel's is `<playlistId>:<streamId>`.
      const key = playlistRef ? `${playlistRef}:${channel.stream_id}` : String(channel.stream_id)
      if (requestedRef.current.has(key)) return
      requestedRef.current.add(key)
      queueRef.current.push(async () => {
        const client = playlistRef ? new XtreamClient(playlistRef) : session.client
        try {
          const listings = await client.getShortEpg(channel.stream_id, 4)
          setShortEpgByStream((prev) => ({ ...prev, [key]: listings }))
        } catch {
          // Best-effort — a channel with no/failed EPG just shows an empty timeline, not an error.
          setShortEpgByStream((prev) => ({ ...prev, [key]: [] }))
        }
      })
      pump()
    },
    [session, pump]
  )

  return { shortEpgByStream, request }
}

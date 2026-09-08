import { useCallback, useRef, useState } from 'react'
import type { Session } from '../components/LoginScreen'
import type { ShortEpgProgram } from './types'

const MAX_CONCURRENT_FETCHES = 4

// Ported from the desktop app's useAppStore.ts (loadShortEpg + its module-level queue) — a
// per-channel EPG fetch (get_short_epg) queued behind a small concurrency cap rather than
// fired for every visible row at once, which matters a lot here: without it, scrolling a large
// category's worth of rows into view (or worse, rendering "All") would fire potentially
// thousands of simultaneous requests at the server/provider instead of a steady trickle of 4.
export function useShortEpgCache(session: Session): {
  shortEpgByStream: Record<number, ShortEpgProgram[]>
  request: (streamId: number) => void
} {
  const [shortEpgByStream, setShortEpgByStream] = useState<Record<number, ShortEpgProgram[]>>({})
  const requestedRef = useRef(new Set<number>())
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
    (streamId: number) => {
      if (requestedRef.current.has(streamId)) return
      requestedRef.current.add(streamId)
      queueRef.current.push(async () => {
        try {
          const listings = await session.client.getShortEpg(streamId, 4)
          setShortEpgByStream((prev) => ({ ...prev, [streamId]: listings }))
        } catch {
          // Best-effort — a channel with no/failed EPG just shows an empty timeline, not an error.
          setShortEpgByStream((prev) => ({ ...prev, [streamId]: [] }))
        }
      })
      pump()
    },
    [session, pump]
  )

  return { shortEpgByStream, request }
}

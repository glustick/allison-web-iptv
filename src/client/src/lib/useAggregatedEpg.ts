import { useEffect, useRef, useState } from 'react'
import type { Session } from '../components/LoginScreen'

// The aggregated, server-assembled programme guide — replaces the old useFullEpgGuide, which
// downloaded the provider's ~98MB xmltv.php into every browser tab and joined it to channels by
// exact epg_channel_id only. /api/epg (see the server's epgService.ts) fetches, caches, and
// merges the provider guide with any extra user-configured XMLTV sources server-side, applies
// the wider channel matching there, and returns only the programmes overlapping the requested
// time window keyed by stream_id — so this hook refetches whenever the grid's window moves
// (hour-step navigation), keeps the last good window on screen while the next one loads, and
// memoizes visited windows so navigating back is instant.

export interface AggregatedEpgProgramme {
  startMs: number
  stopMs: number
  title: string
  description?: string
}

export interface AggregatedEpgSource {
  kind: 'provider' | 'external'
  url: string
  status: 'ok' | 'error'
  channelCount: number
  programmeCount: number
  fetchedAt: number | null
  error?: string
}

export interface AggregatedEpgData {
  sources: AggregatedEpgSource[]
  listings: Record<string, AggregatedEpgProgramme[]>
}

export function useAggregatedEpg(
  session: Session,
  windowStart: number,
  windowEnd: number
): { data: AggregatedEpgData | null; status: 'loading' | 'ready' | 'error' } {
  const [data, setData] = useState<AggregatedEpgData | null>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const windowCacheRef = useRef(new Map<string, AggregatedEpgData>())
  const latestKeyRef = useRef<string | null>(null)

  useEffect(() => {
    const key = `${session.server}|${session.username}|${windowStart}|${windowEnd}`
    if (latestKeyRef.current === key) return
    latestKeyRef.current = key

    const cached = windowCacheRef.current.get(key)
    if (cached) {
      setData(cached)
      setStatus('ready')
      return
    }

    let active = true
    fetch(`/api/epg?start=${windowStart}&end=${windowEnd}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return (await res.json()) as AggregatedEpgData
      })
      .then((next) => {
        if (!active || latestKeyRef.current !== key) return
        windowCacheRef.current.set(key, next)
        if (windowCacheRef.current.size > 24) {
          // Drop the oldest entries — window navigation is hour-stepped, so 24 cached windows
          // covers a full day in each direction, which is far beyond the data's own horizon.
          const oldest = windowCacheRef.current.keys().next().value
          if (oldest !== undefined) windowCacheRef.current.delete(oldest)
        }
        setData(next)
        setStatus('ready')
      })
      .catch((err) => {
        if (!active || latestKeyRef.current !== key) return
        console.error('[epg] failed to load the aggregated guide:', err)
        setStatus('error')
      })
    return () => {
      active = false
    }
  }, [session, windowStart, windowEnd])

  return { data, status }
}

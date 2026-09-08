import { useEffect, useRef, useState } from 'react'
import type { Session } from '../components/LoginScreen'
import { parseXmltv, type EpgData } from './epg'

// Fetched once per session (not per category/channel-switch) and cached for the component
// tree's lifetime — this is a single bulk request (confirmed live against the real account
// this project tests against: ~98MB of XML) rather than one request per channel, so there's no
// concurrency concern here the way useShortEpgCache.ts has to manage for its own per-channel
// fetches. `status` distinguishes "still loading" from "loaded but genuinely has nothing for
// this channel" from "the provider doesn't serve this at all" (some 403 on it — see lib/epg.ts's
// own doc comment) — EpgGrid.tsx uses that to decide when it's safe to fall back to the
// per-channel queue instead.
export function useFullEpgGuide(session: Session): { data: EpgData | null; status: 'loading' | 'ready' | 'error' } {
  const [data, setData] = useState<EpgData | null>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const fetchedForRef = useRef<Session | null>(null)

  useEffect(() => {
    if (fetchedForRef.current === session) return
    fetchedForRef.current = session
    setStatus('loading')
    session.client
      .getFullEpgXml()
      .then((xml) => {
        setData(parseXmltv(xml))
        setStatus('ready')
      })
      .catch((err) => {
        console.error('[epg] failed to load the full XMLTV guide:', err)
        setStatus('error')
      })
  }, [session])

  return { data, status }
}

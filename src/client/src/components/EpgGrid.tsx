import { useEffect, useState, type CSSProperties, type JSX } from 'react'
import { List, useListRef } from 'react-window'
import { pct } from '../lib/epgTime'
import type { Session } from './LoginScreen'
import { useShortEpgCache } from '../lib/useShortEpgCache'
import { useFullEpgGuide } from '../lib/useFullEpgGuide'
import type { EpgData } from '../lib/epg'
import type { LiveStream, ShortEpgProgram } from '../lib/types'

const HOUR_MS = 3_600_000
const WINDOW_HOURS = 3
const CHANNEL_COLUMN_WIDTH = 160

interface Block {
  key: string
  startMs: number
  stopMs: number
  title: string
  description?: string
}

function formatHour(t: number): string {
  return new Date(t).toLocaleTimeString([], { hour: 'numeric' })
}

function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

// The full XMLTV guide (see lib/epg.ts) is the primary source — one bulk fetch, confirmed live
// to have real data on the real account this project tests against. get_short_epg (per-channel,
// queued behind a concurrency cap — see useShortEpgCache.ts) is only actually used as a
// fallback, for a channel the full guide has nothing for once it's finished loading, or if the
// full guide failed to load at all (some providers 403 on it — see epg.ts's own comment).
function useChannelListings(
  channel: LiveStream,
  fullEpg: { data: EpgData | null; status: 'loading' | 'ready' | 'error' },
  shortEpgByStream: Record<number, ShortEpgProgram[]>,
  requestShortEpg: (streamId: number) => void
): Block[] | undefined {
  const fromGuide = channel.epg_channel_id ? fullEpg.data?.programmesByChannel.get(channel.epg_channel_id) : undefined
  const guideHasNothing = fullEpg.status === 'ready' && (fromGuide === undefined || fromGuide.length === 0)
  const shouldUseFallback = fullEpg.status === 'error' || guideHasNothing

  useEffect(() => {
    if (shouldUseFallback) requestShortEpg(channel.stream_id)
  }, [shouldUseFallback, channel.stream_id, requestShortEpg])

  if (fromGuide && fromGuide.length > 0) {
    return fromGuide.map((p) => ({
      key: `${p.channelId}-${p.start.getTime()}`,
      startMs: p.start.getTime(),
      stopMs: p.stop.getTime(),
      title: p.title,
      description: p.description
    }))
  }
  if (shouldUseFallback) {
    const listings = shortEpgByStream[channel.stream_id]
    if (listings === undefined) return undefined
    return listings.map((p, i) => ({
      key: `${p.id}-${i}`,
      startMs: Number(p.start_timestamp) * 1000,
      stopMs: Number(p.stop_timestamp) * 1000,
      title: p.title,
      description: p.description
    }))
  }
  // Full guide is still loading and this channel has no fallback in flight yet — render as
  // "loading", same as the fallback's own undefined-listings case, rather than "confirmed empty".
  return undefined
}

interface RowProps {
  channels: LiveStream[]
  windowStart: number
  windowEnd: number
  now: number
  activeStreamId?: number
  fullEpg: { data: EpgData | null; status: 'loading' | 'ready' | 'error' }
  shortEpgByStream: Record<number, ShortEpgProgram[]>
  requestShortEpg: (streamId: number) => void
  onSelectChannel: (channel: LiveStream) => void
}

function EpgRow({
  index,
  style,
  channels,
  windowStart,
  windowEnd,
  now,
  activeStreamId,
  fullEpg,
  shortEpgByStream,
  requestShortEpg,
  onSelectChannel
}: { index: number; style: CSSProperties } & RowProps): JSX.Element {
  const channel = channels[index]
  const listings = useChannelListings(channel, fullEpg, shortEpgByStream, requestShortEpg)
  const visible = (listings ?? []).filter((p) => p.stopMs > windowStart && p.startMs < windowEnd)
  const isActive = activeStreamId === channel.stream_id
  const nowPct = pct(now, windowStart, windowEnd)
  const showNowLine = now >= windowStart && now <= windowEnd

  return (
    <div style={style} className={isActive ? 'epg-row active' : 'epg-row'}>
      <button className="epg-row-channel" onClick={() => onSelectChannel(channel)}>
        {channel.stream_icon ? <img src={channel.stream_icon} alt="" loading="lazy" /> : <span className="epg-row-channel-icon placeholder" />}
        <span className="epg-row-channel-name">{channel.name}</span>
      </button>
      <div className="epg-row-timeline">
        {listings === undefined && <div className="epg-row-loading" />}
        {visible.map((p) => {
          const left = pct(p.startMs, windowStart, windowEnd)
          const width = Math.max(pct(p.stopMs, windowStart, windowEnd) - left, 2)
          const isPast = p.stopMs <= now
          return (
            <button
              key={p.key}
              className={isPast ? 'epg-block epg-block--past' : 'epg-block'}
              style={{ left: `${left}%`, width: `${width}%` }}
              title={`${formatTime(p.startMs)} – ${formatTime(p.stopMs)}\n${p.title}${p.description ? '\n' + p.description : ''}`}
              onClick={(e) => {
                e.stopPropagation()
                onSelectChannel(channel)
              }}
            >
              <span className="epg-block-label">{p.title}</span>
            </button>
          )
        })}
        {showNowLine && <div className="epg-now-indicator" style={{ left: `${nowPct}%` }} />}
      </div>
    </div>
  )
}

// A simplified port of the desktop app's own Gantt-chart EPG guide: channels down the vertical
// axis (virtualized via react-window, so it stays workable against a catalog with thousands of
// channels), time left-to-right, each programme a positioned block sized by its duration.
// Deliberately left out of this pass (see the desktop app's EpgGrid.tsx for the fuller
// version): drag-to-pan the timeline, a resizable channel column, keyboard navigation, and
// catch-up/timeshift playback for past programmes.
export function EpgGrid({
  session,
  channels,
  activeStreamId,
  onSelectChannel
}: {
  session: Session
  channels: LiveStream[]
  activeStreamId?: number
  onSelectChannel: (channel: LiveStream) => void
}): JSX.Element {
  const [now, setNow] = useState(() => Date.now())
  const [windowOffsetMs, setWindowOffsetMs] = useState(0)
  const listRef = useListRef(null)
  const fullEpg = useFullEpgGuide(session)
  const { shortEpgByStream, request } = useShortEpgCache(session)

  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(interval)
  }, [])

  const baseHour = Math.floor(Date.now() / HOUR_MS) * HOUR_MS
  const windowStart = baseHour + windowOffsetMs
  const windowEnd = windowStart + WINDOW_HOURS * HOUR_MS

  const firstTick = Math.ceil(windowStart / HOUR_MS) * HOUR_MS
  const hourTicks: number[] = []
  for (let t = firstTick; t <= windowEnd; t += HOUR_MS) hourTicks.push(t)

  return (
    <div className="epg-grid" style={{ '--epg-channel-col-width': `${CHANNEL_COLUMN_WIDTH}px` } as CSSProperties}>
      <div className="epg-time-header">
        <div className="epg-grid-nav">
          <button onClick={() => setWindowOffsetMs((o) => o - HOUR_MS)} title="Earlier">
            ◀
          </button>
          <button onClick={() => setWindowOffsetMs(0)} title="Jump to now">
            Now
          </button>
          <button onClick={() => setWindowOffsetMs((o) => o + HOUR_MS)} title="Later">
            ▶
          </button>
        </div>
        <div className="epg-time-header-track">
          {hourTicks.map((t) => (
            <span key={t} className="epg-time-tick" style={{ left: `${pct(t, windowStart, windowEnd)}%` }}>
              {formatHour(t)}
            </span>
          ))}
        </div>
        {fullEpg.status === 'loading' && <div className="epg-time-header-controls">Loading guide…</div>}
      </div>
      <div className="epg-grid-body">
        {channels.length === 0 ? (
          <p className="now-playing-bar">No channels to show.</p>
        ) : (
          <List<RowProps>
            listRef={listRef}
            rowCount={channels.length}
            rowHeight={40}
            rowProps={{
              channels,
              windowStart,
              windowEnd,
              now,
              activeStreamId,
              fullEpg,
              shortEpgByStream,
              requestShortEpg: request,
              onSelectChannel
            }}
            rowComponent={EpgRow}
            style={{ height: '100%', width: '100%' }}
          />
        )}
      </div>
    </div>
  )
}

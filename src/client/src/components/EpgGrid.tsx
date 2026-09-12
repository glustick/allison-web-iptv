import { useEffect, useState, type CSSProperties, type JSX } from 'react'
import { List, useListRef } from 'react-window'
import { pct } from '../lib/epgTime'
import type { Session } from './LoginScreen'
import { useShortEpgCache } from '../lib/useShortEpgCache'
import { useAggregatedEpg, type AggregatedEpgData } from '../lib/useAggregatedEpg'
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

// The aggregated server-side guide (see useAggregatedEpg.ts) is the primary source — the
// provider's own xmltv.php merged with any extra user-configured XMLTV sources, matched to
// streams by the server's wider id/name matching. get_short_epg (per-channel, queued behind a
// concurrency cap — see useShortEpgCache.ts) remains the fallback, for a channel the aggregate
// has nothing for once it's finished loading, or if the aggregate failed to load at all.
function useChannelListings(
  channel: LiveStream,
  aggregated: { data: AggregatedEpgData | null; status: 'loading' | 'ready' | 'error' },
  shortEpgByStream: Record<number, ShortEpgProgram[]>,
  requestShortEpg: (streamId: number) => void
): Block[] | undefined {
  const fromAggregate = aggregated.data?.listings[String(channel.stream_id)]
  const aggregateHasNothing = aggregated.status === 'ready' && (!fromAggregate || fromAggregate.length === 0)
  const shouldUseFallback = aggregated.status === 'error' || aggregateHasNothing

  useEffect(() => {
    if (shouldUseFallback) requestShortEpg(channel.stream_id)
  }, [shouldUseFallback, channel.stream_id, requestShortEpg])

  if (fromAggregate && fromAggregate.length > 0) {
    return fromAggregate.map((p) => ({
      key: `${channel.stream_id}-${p.startMs}`,
      startMs: p.startMs,
      stopMs: p.stopMs,
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
  // Aggregate is still loading and this channel has no fallback in flight yet — render as
  // "loading", same as the fallback's own undefined-listings case, rather than "confirmed empty".
  return undefined
}

interface RowProps {
  channels: LiveStream[]
  windowStart: number
  windowEnd: number
  now: number
  activeStreamId?: number
  aggregated: { data: AggregatedEpgData | null; status: 'loading' | 'ready' | 'error' }
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
  aggregated,
  shortEpgByStream,
  requestShortEpg,
  onSelectChannel
}: { index: number; style: CSSProperties } & RowProps): JSX.Element {
  const channel = channels[index]
  const listings = useChannelListings(channel, aggregated, shortEpgByStream, requestShortEpg)
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
        {listings !== undefined && listings.length === 0 && (
          <span className="epg-row-empty">No guide data</span>
        )}
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

  const baseHour = Math.floor(Date.now() / HOUR_MS) * HOUR_MS
  const windowStart = baseHour + windowOffsetMs
  const windowEnd = windowStart + WINDOW_HOURS * HOUR_MS

  const aggregated = useAggregatedEpg(session, windowStart, windowEnd)
  const { shortEpgByStream, request } = useShortEpgCache(session)

  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(interval)
  }, [])

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
        {aggregated.status === 'loading' && aggregated.data === null && (
          <div className="epg-time-header-controls">Loading guide…</div>
        )}
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
              aggregated,
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

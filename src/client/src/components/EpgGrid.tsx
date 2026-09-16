import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type JSX,
  type PointerEvent as ReactPointerEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react'
import { List, useListRef } from 'react-window'
import { pct } from '../lib/epgTime'
import { clampScrollOffset, EPG_PAN_SNAP_MS, offsetAfterArrowKey, panAxis, windowOffsetAfterDrag } from '../lib/epgPan'
import { catchupForProgramme, restartRequestForProgramme } from '../lib/catchup'
import type { Session } from '../lib/appAuth'
import { useShortEpgCache } from '../lib/useShortEpgCache'
import { useAggregatedEpg, type AggregatedEpgData } from '../lib/useAggregatedEpg'
import { loadSavedDimension, saveDimension, useResizableDimension } from '../lib/useResizableDimension'
import type { LiveStream, ShortEpgProgram } from '../lib/types'

const HOUR_MS = 3_600_000
// The channel row height, in one place: the List renders rows at this size and the keyboard
// arrows scroll by exactly one of them.
const ROW_HEIGHT = 40
const WINDOW_HOURS = 3

// The channel column is drag-resizable (see useResizableDimension.ts) with the desktop app's
// own v0.7.9 clamps; the width feeds --epg-channel-col-width below, which is the only thing
// .epg-grid-nav and .epg-row-channel consume — rows never read it in JS, so react-window
// re-renders nothing while dragging.
const EPG_CHANNEL_COL_KEY = 'epg-channel-col-width'
const EPG_CHANNEL_COL_MIN = 90
const EPG_CHANNEL_COL_MAX = 320
const EPG_CHANNEL_COL_DEFAULT = 160

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
  /** Drag-to-pan the whole grid (see lib/epgPan.ts): left/right moves the window through time,
   *  up/down moves the channel list. Attached to each row's timeline *and* its channel name, so the
   *  guide can be grabbed anywhere rather than only on the ruler. */
  onTimelinePointerDown: (event: ReactPointerEvent<HTMLElement>) => void
  onTimelinePointerMove: (event: ReactPointerEvent<HTMLElement>) => void
  onTimelinePointerUp: (event: ReactPointerEvent<HTMLElement>) => void
  /** True while the pointer has actually panned — a drag must not also fire the click that
   *  selecting a channel rides on. */
  onPlayCatchup?: (channel: LiveStream, programme: { startMs: number; stopMs: number; title: string }) => void
  /// Restarting a programme that is still on air: the same archive, from its beginning.
  onRestartProgramme?: (channel: LiveStream, programme: { startMs: number; stopMs: number; title: string }) => void
  didPan: () => boolean
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
  onSelectChannel,
  onTimelinePointerDown,
  onTimelinePointerMove,
  onTimelinePointerUp,
  onPlayCatchup,
    onRestartProgramme,
  didPan
}: { index: number; style: CSSProperties } & RowProps): JSX.Element {
  const channel = channels[index]
  const listings = useChannelListings(channel, aggregated, shortEpgByStream, requestShortEpg)
  const visible = (listings ?? []).filter((p) => p.stopMs > windowStart && p.startMs < windowEnd)
  const isActive = activeStreamId === channel.stream_id
  const nowPct = pct(now, windowStart, windowEnd)
  const showNowLine = now >= windowStart && now <= windowEnd

  return (
    <div style={style} className={isActive ? 'epg-row active' : 'epg-row'}>
      <button
        className="epg-row-channel"
        onPointerDown={onTimelinePointerDown}
        onPointerMove={onTimelinePointerMove}
        onPointerUp={onTimelinePointerUp}
        onPointerCancel={onTimelinePointerUp}
        onClick={() => {
          if (didPan()) return
          onSelectChannel(channel)
        }}
      >
        {channel.stream_icon ? <img src={channel.stream_icon} alt="" loading="lazy" /> : <span className="epg-row-channel-icon placeholder" />}
        <span className="epg-row-channel-name">{channel.name}</span>
      </button>
      <div
        className="epg-row-timeline"
        onPointerDown={onTimelinePointerDown}
        onPointerMove={onTimelinePointerMove}
        onPointerUp={onTimelinePointerUp}
        onPointerCancel={onTimelinePointerUp}
        title="Drag left/right to move the guide through time, up/down to move through channels"
      >
        {listings === undefined && <div className="epg-row-loading" />}
        {listings !== undefined && listings.length === 0 && (
          <span className="epg-row-empty">No guide data</span>
        )}
        {visible.map((p) => {
          const left = pct(p.startMs, windowStart, windowEnd)
          const width = Math.max(pct(p.stopMs, windowStart, windowEnd) - left, 2)
          const isPast = p.stopMs <= now
          const catchup = isPast && onPlayCatchup ? catchupForProgramme(channel, p, now) : null
          // Still on air, and the channel keeps an archive: offer a restart from the beginning (the same
          // request with now as the end). Double-click rather than click, because clicking a live
          // programme has to keep playing the channel.
          const restart = !isPast && onRestartProgramme ? restartRequestForProgramme(channel, p, now) : null
          return (
            <button
              key={p.key}
              className={`epg-block${isPast ? ' epg-block--past' : ''}${catchup ? ' epg-block--catchup' : ''}`}
              style={{ left: `${left}%`, width: `${width}%` }}
              title={`${formatTime(p.startMs)} – ${formatTime(p.stopMs)}\n${p.title}${p.description ? '\n' + p.description : ''}${catchup ? '\n▶ Play from catch-up' : ''}${restart ? '\nDouble-click to start from the beginning' : ''}`}
              onKeyDown={(event) => {
                // Shift+Enter is the keyboard's version of the double-click below.
                if (event.key === 'Enter' && event.shiftKey && restart && onRestartProgramme) {
                  event.preventDefault()
                  event.stopPropagation()
                  onRestartProgramme(channel, { startMs: p.startMs, stopMs: p.stopMs, title: p.title })
                  return
                }
                // Arrow up/down moves focus a row at a time, staying in the same column of the guide. The
                // row above or below is drawn by the same virtualised list, so ask the document what sits at
                // the equivalent point rather than tracking indices the list can throw away.
                if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
                const rect = event.currentTarget.getBoundingClientRect()
                const delta = event.key === 'ArrowDown' ? ROW_HEIGHT : -ROW_HEIGHT
                const under = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2 + delta)
                const target = under?.closest('button.epg-block')
                if (target instanceof HTMLElement) {
                  event.preventDefault()
                  event.stopPropagation()
                  target.focus()
                }
                // No row that way: say nothing, so the event reaches the grid and it scrolls instead.
              }}
              onDoubleClick={() => { if (restart && onRestartProgramme) onRestartProgramme(channel, { startMs: p.startMs, stopMs: p.stopMs, title: p.title }) }}
              onClick={(e) => {
                e.stopPropagation()
                if (didPan()) return
                if (catchup && onPlayCatchup) {
                  onPlayCatchup(channel, { startMs: p.startMs, stopMs: p.stopMs, title: p.title })
                  return
                }
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
// Drag-to-pan is implemented both ways (see lib/epgPan.ts): grabbing the guide — the time ruler,
// any row's timeline, or a channel name — slides the window through time when dragged left/right
// and moves the channel list when dragged up/down. One axis per gesture, and a drag never doubles
// as the click that selects a channel. Still left out of this pass (see the desktop app's EpgGrid.tsx
// for the fuller version): keyboard navigation and catch-up/timeshift playback for past
// programmes.
export function EpgGrid({
  session,
  channels,
  activeStreamId,
  onSelectChannel,
  onOpenEpgSettings,
  emptyMessage,
  onPlayCatchup,
    onRestartProgramme,
}: {
  session: Session
  channels: LiveStream[]
  activeStreamId?: number
  onSelectChannel: (channel: LiveStream | null) => void
  /** Jumps to the EPG section — the place external guide sources are added/removed. */
  onPlayCatchup?: (channel: LiveStream, programme: { startMs: number; stopMs: number; title: string }) => void
  onRestartProgramme?: (channel: LiveStream, programme: { startMs: number; stopMs: number; title: string }) => void
  onOpenEpgSettings?: () => void
  /** Shown when there are no rows (library views explain themselves this way). */
  emptyMessage?: string
}): JSX.Element {
  const [now, setNow] = useState(() => Date.now())
  const [windowOffsetMs, setWindowOffsetMs] = useState(0)
  const listRef = useListRef(null)
  // Drag-to-pan (was deliberately left out of the first pass — see this file's own doc comment
  // below). The offset lives in a ref as well as state so the drag reads the value it started
  // from without depending on a fresh render, and so the whole gesture is one pointer capture
  // rather than a state update per move.
  const offsetRef = useRef(0)
  offsetRef.current = windowOffsetMs
  const panRef = useRef<{
    startX: number
    startY: number
    startOffset: number
    width: number
    startScrollTop: number
    maxScrollTop: number
  } | null>(null)
  const pannedRef = useRef(false)
  const didPan = useCallback((): boolean => pannedRef.current, [])
  const [panning, setPanning] = useState(false)
  const { dimension: channelColumnWidth, startDrag: startChannelColumnDrag } = useResizableDimension(
    loadSavedDimension(EPG_CHANNEL_COL_KEY, EPG_CHANNEL_COL_DEFAULT, EPG_CHANNEL_COL_MIN, EPG_CHANNEL_COL_MAX),
    'x',
    {
      min: EPG_CHANNEL_COL_MIN,
      max: EPG_CHANNEL_COL_MAX,
      onCommit: (w) => saveDimension(EPG_CHANNEL_COL_KEY, w)
    }
  )

  const baseHour = Math.floor(Date.now() / HOUR_MS) * HOUR_MS
  const windowStart = baseHour + windowOffsetMs
  const windowEnd = windowStart + WINDOW_HOURS * HOUR_MS

  const aggregated = useAggregatedEpg(session, windowStart, windowEnd)
  const { shortEpgByStream, request } = useShortEpgCache(session)

  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(interval)
  }, [])

  const startPan = useCallback((event: ReactPointerEvent<HTMLElement>): void => {
    if (event.button !== 0) return
    // A fresh gesture: whatever the previous one did, this one starts as a potential click.
    pannedRef.current = false
    // react-window 2 has no scrollTo(offset) — only row-based scrolling — so a pixel drag works on
    // its scroller element directly. Both where it was and how far it can go are captured at the
    // start of the gesture, so the drag stays 1:1 with the pointer rather than accumulating error.
    const scroller = listRef.current?.element ?? null
    panRef.current = {
      startX: event.clientX,
      startY: event.clientY,
      startOffset: offsetRef.current,
      width: event.currentTarget.clientWidth,
      startScrollTop: scroller?.scrollTop ?? 0,
      maxScrollTop: scroller ? Math.max(0, scroller.scrollHeight - scroller.clientHeight) : 0
    }
    // Deliberately *not* capturing the pointer on press. Pointer capture also retargets the
    // compatibility mouse events, so a click on a programme block would be delivered to the element
    // that captured — this drag surface — and the block's own handler would never run. A synthetic
    // .click() bypasses all of that, which is exactly how the breakage hid: real clicks stopped
    // selecting anything the day panning was added. Capture is taken below, once a drag starts.
    setPanning(true)
  }, [])

  const movePan = useCallback((event: ReactPointerEvent<HTMLElement>): void => {
    const pan = panRef.current
    if (!pan) return
    const axis = panAxis(pan.startX, pan.startY, event.clientX, event.clientY)
    // Below the threshold this is still a click on whatever is under the pointer.
    if (axis === 'none') return
    if (!pannedRef.current) {
      pannedRef.current = true
      // Now it is a drag, keep receiving moves even when the pointer leaves this element.
      try {
        event.currentTarget.setPointerCapture(event.pointerId)
      } catch {
        /* capture is an optimisation, not a requirement */
      }
    }

    if (axis === 'time') {
      const next = windowOffsetAfterDrag(
        pan.startOffset,
        pan.startX,
        event.clientX,
        pan.width,
        WINDOW_HOURS * HOUR_MS
      )
      setWindowOffsetMs((current) => (current === next ? current : next))
      return
    }

    // Vertical: the same grab, moving through the channel list instead of through time.
    const scroller = listRef.current?.element
    if (scroller) {
      scroller.scrollTop = clampScrollOffset(pan.startScrollTop - (event.clientY - pan.startY), pan.maxScrollTop)
    }
  }, [])

  // Keyboard: the programme blocks are real buttons, so Tab reaches them and Enter plays them
  // already — what was missing is movement. Arrows pan the window (a quarter hour, matching the
  // drag's own snap) and step the channel list; Home comes back to now. See .epg-block:focus-visible
  // for the focus ring that makes any of this discoverable.
  const onGridKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault()
      setWindowOffsetMs((current) => offsetAfterArrowKey(current, event.key as 'ArrowLeft' | 'ArrowRight'))
      return
    }
    if (event.key === 'Home') {
      event.preventDefault()
      setWindowOffsetMs(0)
      return
    }
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      const scroller = listRef.current?.element
      if (!scroller) return
      event.preventDefault()
      scroller.scrollTop += (event.key === 'ArrowDown' ? 1 : -1) * 40
    }
  }, [])
  const endPan = useCallback((event: ReactPointerEvent<HTMLElement>): void => {
    panRef.current = null
    setPanning(false)
    setTimeout(() => {
      pannedRef.current = false
    }, 0)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    // pannedRef stays set through the click that follows this pointerup — that click must not
    // select the channel the user just dragged past — and is cleared on the next macrotask, once
    // that click has been handled. Clearing on pointerdown alone would swallow a keyboard
    // activation (Enter on a focused programme fires a click with no pointerdown at all).
  }, [])

  const firstTick = Math.ceil(windowStart / HOUR_MS) * HOUR_MS
  const hourTicks: number[] = []
  for (let t = firstTick; t <= windowEnd; t += HOUR_MS) hourTicks.push(t)

  return (
    <div
      tabIndex={-1}
      // One keydown handler for the whole guide: arrows pan and scroll, Enter plays a block.
      onKeyDown={onGridKeyDown}
      className={panning ? 'epg-grid epg-grid--panning' : 'epg-grid'}
      style={{ '--epg-channel-col-width': `${channelColumnWidth}px` } as CSSProperties}
    >
      {/* One handle spanning the grid's full height — the header's nav block and every row's
          channel cell share the same width variable, so a single divider moves them together
          (the desktop app's own v0.7.9 arrangement). */}
      <div
        className="resize-handle resize-handle--col"
        style={{ left: channelColumnWidth - 4 }}
        onPointerDown={startChannelColumnDrag}
        title="Drag to resize the channel column"
      />
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
        <div
          className="epg-time-header-track"
          onPointerDown={startPan}
          onPointerMove={movePan}
          onPointerUp={endPan}
          onPointerCancel={endPan}
          title="Drag left/right to move the guide through time, up/down to move through channels"
        >
          {hourTicks.map((t) => (
            <span key={t} className="epg-time-tick" style={{ left: `${pct(t, windowStart, windowEnd)}%` }}>
              {formatHour(t)}
            </span>
          ))}
        </div>
        {aggregated.status === 'loading' && aggregated.data === null && (
          <div className="epg-time-header-controls">Loading guide…</div>
        )}
        {onOpenEpgSettings && (
          <button
            type="button"
            className="epg-sources-link"
            onClick={onOpenEpgSettings}
            title="Missing guide data? Add or remove external EPG (XMLTV) sources"
          >
            EPG sources
          </button>
        )}
      </div>
      <div className="epg-grid-body">
        {channels.length === 0 ? (
          <p className="now-playing-bar">{emptyMessage ?? 'No channels to show.'}</p>
        ) : (
          <List<RowProps>
            listRef={listRef}
            rowCount={channels.length}
            rowHeight={ROW_HEIGHT}
            rowProps={{
              channels,
              windowStart,
              windowEnd,
              now,
              activeStreamId,
              aggregated,
              shortEpgByStream,
              requestShortEpg: request,
              onSelectChannel,
              onPlayCatchup,
                            onRestartProgramme,
              onTimelinePointerDown: startPan,
              onTimelinePointerMove: movePan,
              onTimelinePointerUp: endPan,
              didPan
            }}
            rowComponent={EpgRow}
            style={{ height: '100%', width: '100%' }}
          />
        )}
      </div>
    </div>
  )
}

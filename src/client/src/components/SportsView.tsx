import { useCallback, useEffect, useMemo, useState, type CSSProperties, type JSX } from 'react'
import type { Session } from '../lib/appAuth'
import { reportNowPlaying } from '../lib/activityReporter'
import { LivePlayer } from './LivePlayer'
import { useSidebarWidth } from '../lib/useSidebarWidth'
import { loadSavedDimension, saveDimension, useResizableDimension } from '../lib/useResizableDimension'
import {
  buildSportsSchedule,
  classifyCategory,
  dayKeyOf,
  gamesForDay,
  type SportsGame,
  type SportsGroup
} from '../lib/sports'
import { dualTimeLabel, formatDualFromWall } from '../lib/gameTimes'
import type { Category, LiveStream } from '../lib/types'

// The Sports tab: the desktop sibling's (iptv-app 0.7.109), ported to the browser. Competitions
// (api-football-style leagues) → the day's games → the channels carrying a game → the existing
// live player. Every number comes from the provider's own catalogue filtered through the pure
// lib/sports.ts; there is no external service in phase 1 (api-football fixtures are a later
// phase, see ROADMAP).
//
// The one adaptation from the desktop: it reads a whole-catalogue cache it already holds from
// the store, whereas this app fetches per category. So the Sports tab fetches only the
// categories that classify as sports — a fraction of a 27k-channel catalogue — rather than
// pulling the entire live list just to discard most of it.

const DAY_RANGE = 7
// A handful of high-school/regional categories parse into thousands of games; rendering them
// all in a plain list would freeze the pane. The count is still shown so the size is honest.
const MAX_ROWS = 300
const PLAYER_MAX_HEIGHT_KEY = 'allisoniptv-sports-player-max-height'
const FEEDS_WIDTH_KEY = 'allisoniptv-sports-feeds-width'
const PLAYER_MIN_HEIGHT = 120
const PLAYER_DEFAULT_MAX_HEIGHT = (): number => Math.round(window.innerHeight * 0.45)
const PLAYER_MAX_HEIGHT_CEILING = (): number => Math.round(window.innerHeight * 0.8)

/** Whether this locale reads 12-hour times, asked of Intl rather than assumed. */
function localeUses12Hour(): boolean {
  try {
    return /am|pm/i.test(new Intl.DateTimeFormat(undefined, { hour: 'numeric' }).format(new Date(2020, 0, 1, 13)))
  } catch {
    return false
  }
}

function formatDayLabel(dayKey: string): string {
  const [year, month, date] = dayKey.split('-').map(Number)
  const d = new Date(year, month - 1, date)
  const today = dayKeyOf(new Date())
  if (dayKey === today) return 'Today'
  const tomorrow = dayKeyOf(new Date(Date.now() + 86_400_000))
  if (dayKey === tomorrow) return 'Tomorrow'
  return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })
}

/**
 * Kickoff times show BOTH sides: the venue's wall clock and the viewer's local one
 * ("15:00 ET · 03:00 +1d"). When both read the same numbers only one is shown — a repeated
 * identical time is noise, not information.
 */
function formatKickoff(game: SportsGame, hour12: boolean): string {
  if (!game.kickoff) return 'Time TBD'
  if (game.venueTime) {
    return dualTimeLabel(
      formatDualFromWall(
        game.venueTime.hour,
        game.venueTime.minute,
        game.venueTime.tzLabel,
        game.kickoff.getTime(),
        hour12
      )
    )
  }
  // Date-only names default to a midday placeholder — no real wall time to dual-display.
  return game.kickoff.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function feedCount(count: number): string {
  return `${count} feed${count === 1 ? '' : 's'}`
}

export function SportsView({ session }: { session: Session }): JSX.Element {
  const [categories, setCategories] = useState<Category[]>([])
  const [streams, setStreams] = useState<LiveStream[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [selectedLeagueId, setSelectedLeagueId] = useState<string | null>(null)
  const [dayOffset, setDayOffset] = useState(0)
  const [selectedGameKey, setSelectedGameKey] = useState<string | null>(null)
  const [nowPlaying, setNowPlaying] = useState<LiveStream | null>(null)
  // The schedule buckets games by day, so it is built once against a fixed "now" (rebuilding it
  // against a fresh clock every render would also re-bucket nothing but cost a full pass each
  // time). The day *picker* below uses the live clock, which is what "Today" means to a viewer.
  const [builtAt] = useState(() => new Date())

  const hour12 = useMemo(localeUses12Hour, [])

  const { sidebarWidth, startSidebarDrag } = useSidebarWidth()
  const { dimension: playerMaxHeight, startDrag: startPlayerHeightDrag } = useResizableDimension(
    loadSavedDimension(PLAYER_MAX_HEIGHT_KEY, PLAYER_DEFAULT_MAX_HEIGHT(), PLAYER_MIN_HEIGHT, PLAYER_MAX_HEIGHT_CEILING()),
    'y',
    {
      min: PLAYER_MIN_HEIGHT,
      max: PLAYER_MAX_HEIGHT_CEILING(),
      onCommit: (h) => saveDimension(PLAYER_MAX_HEIGHT_KEY, h)
    }
  )
  const { dimension: feedsWidth, startDrag: startFeedsDrag } = useResizableDimension(
    loadSavedDimension(FEEDS_WIDTH_KEY, 320, 220, 640),
    'x',
    { min: 220, max: 640, onCommit: (w) => saveDimension(FEEDS_WIDTH_KEY, w) }
  )

  useEffect(() => {
    session.client
      .getLiveCategories()
      .then(setCategories)
      .catch((err) => {
        setLoadError(err instanceof Error ? err.message : 'Failed to load categories')
        setLoading(false)
      })
  }, [session])

  // Only the categories that classify as a sport (a competition or a carrier) — see the module
  // comment. A category that fails to load contributes nothing rather than failing the tab.
  const sportsCategoryIds = useMemo(
    () => categories.filter((c) => classifyCategory(c.category_name) !== null).map((c) => c.category_id),
    [categories]
  )

  useEffect(() => {
    if (sportsCategoryIds.length === 0) return
    let cancelled = false
    setLoading(true)
    void Promise.all(
      sportsCategoryIds.map((id) => session.client.getLiveStreams(id).catch(() => [] as LiveStream[]))
    )
      .then((lists) => {
        if (cancelled) return
        setStreams(lists.flat())
        setLoading(false)
      })
      .catch((err) => {
        if (cancelled) return
        setLoadError(err instanceof Error ? err.message : 'Failed to load sports channels')
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [sportsCategoryIds, session.client])

  useEffect(() => {
    reportNowPlaying(nowPlaying?.name ?? null, 'live')
  }, [nowPlaying])
  useEffect(() => () => reportNowPlaying(null), [])

  const schedule = useMemo(
    () => (categories.length > 0 && streams.length > 0 ? buildSportsSchedule(streams, categories, builtAt) : null),
    [categories, streams, builtAt]
  )

  const selectedLeague: SportsGroup | null =
    schedule?.leagues.find((l) => l.id === selectedLeagueId) ?? null
  const games = selectedLeague ? (schedule?.gamesByLeague[selectedLeague.id] ?? []) : []
  const dayKey = dayKeyOf(new Date(Date.now() + dayOffset * 86_400_000))
  const dayGames = useMemo(() => gamesForDay(games, dayKey), [games, dayKey])
  const unscheduled = useMemo(() => games.filter((g) => g.dayKey === null), [games])
  const selectedGame = games.find((g) => g.key === selectedGameKey) ?? null

  // Channels of the selected competition that carry no event name (plain broadcast feeds of that
  // league) — the feeds pane's fallback listing when no game is selected.
  const leagueCarrierChannels = useMemo(() => {
    if (!selectedLeague) return []
    const ids = new Set(selectedLeague.categoryIds)
    const gameChannelIds = new Set(games.flatMap((g) => g.channels.map((c) => c.stream_id)))
    return streams
      .filter((c) => ids.has(c.category_id) && !gameChannelIds.has(c.stream_id))
      .sort((a, b) => a.num - b.num)
  }, [selectedLeague, streams, games])

  const selectChannel = useCallback((channel: LiveStream): void => {
    setNowPlaying(channel)
  }, [])

  const streamUrl = nowPlaying ? session.client.getStreamUrl('live', nowPlaying.stream_id, 'm3u8') : null

  if (loadError) {
    return (
      <div className="app-body">
        <div className="content">
          <div className="login-error" style={{ padding: '10px 16px' }}>{loadError}</div>
        </div>
      </div>
    )
  }

  const noSports = !loading && schedule !== null && schedule.leagues.length === 0 && schedule.channels.length === 0

  return (
    <div className="app-body">
      <nav className="sidebar" style={{ width: sidebarWidth }} aria-label="Sports">
        <div className="sidebar-section-label">Competitions</div>
        {(schedule?.leagues ?? []).map((league) => (
          <button
            key={league.id}
            className={league.id === selectedLeagueId ? 'category-btn active' : 'category-btn'}
            onClick={() => {
              setSelectedLeagueId(league.id)
              setSelectedGameKey(null)
            }}
            title={`${league.label} — ${league.country} (${feedCount(league.channelCount)})`}
          >
            {league.isFootball ? '⚽ ' : ''}
            {league.label}
          </button>
        ))}
        {(schedule?.channels ?? []).length > 0 && (
          <>
            <div className="sidebar-section-label">Channels</div>
            {schedule?.channels.slice(0, MAX_ROWS).map((channel) => (
              <button key={channel.stream_id} className="category-btn" onClick={() => selectChannel(channel)}>
                {channel.name}
              </button>
            ))}
          </>
        )}
      </nav>

      <div className="content">
        <div
          className="resize-handle resize-handle--col resize-handle--sidebar"
          onPointerDown={startSidebarDrag}
          title="Drag to resize the sidebar"
        />

        {streamUrl && nowPlaying && (
          <div className="player-section" style={{ '--player-max-height': `${playerMaxHeight}px` } as CSSProperties}>
            <LivePlayer url={streamUrl} channelKey={`live:${nowPlaying.stream_id}`} />
            <div className="now-playing-bar">
              <span>Now playing: {nowPlaying.name}</span>
            </div>
            <div
              className="resize-handle resize-handle--row"
              onPointerDown={startPlayerHeightDrag}
              title="Drag to resize the player"
            />
          </div>
        )}

        {loading ? (
          <div className="sports-status">Loading the sports catalogue…</div>
        ) : noSports ? (
          <div className="sports-status">No sports categories on this provider.</div>
        ) : (
          <div className="sports-split">
            <div className="sports-col sports-games">
              <div className="sports-col-head">
                <span className="list-toolbar-title">
                  {selectedLeague ? selectedLeague.label : 'Sports'}
                  {selectedLeague ? <span className="sports-head-sub"> · {selectedLeague.country}</span> : null}
                </span>
                {selectedLeague && (
                  <span className="sports-day-nav" role="group" aria-label="Pick a day">
                    <button
                      type="button"
                      onClick={() => setDayOffset((o) => Math.max(-DAY_RANGE, o - 1))}
                      disabled={dayOffset <= -DAY_RANGE}
                      aria-label="Earlier day"
                      title="Earlier"
                    >
                      ◀
                    </button>
                    <span className="sports-day-label">{formatDayLabel(dayKey)}</span>
                    <button
                      type="button"
                      onClick={() => setDayOffset((o) => Math.min(DAY_RANGE, o + 1))}
                      disabled={dayOffset >= DAY_RANGE}
                      aria-label="Later day"
                      title="Later"
                    >
                      ▶
                    </button>
                  </span>
                )}
              </div>

              <div className="sports-list">
                {!selectedLeague ? (
                  <div className="sports-empty">Pick a competition to see its games.</div>
                ) : (
                  <>
                    {dayGames.length === 0 && (
                      <div className="sports-empty">No games scheduled for this day.</div>
                    )}
                    {dayGames.slice(0, MAX_ROWS).map((game) => (
                      <button
                        key={game.key}
                        className={game.key === selectedGameKey ? 'sports-row active' : 'sports-row'}
                        aria-pressed={game.key === selectedGameKey}
                        onClick={() => setSelectedGameKey(game.key === selectedGameKey ? null : game.key)}
                        title={`${feedCount(game.channels.length)} carry this game`}
                      >
                        <span className="sports-row-label">
                          {game.homeDisplay} vs {game.awayDisplay}
                          <span className="sports-row-time">{formatKickoff(game, hour12)}</span>
                        </span>
                        <span className="sports-row-count">{feedCount(game.channels.length)}</span>
                      </button>
                    ))}
                    {dayGames.length > MAX_ROWS && (
                      <div className="sports-empty">…and {dayGames.length - MAX_ROWS} more games</div>
                    )}
                    {unscheduled.length > 0 && (
                      <>
                        <div className="sports-section">Unscheduled</div>
                        {unscheduled.slice(0, MAX_ROWS).map((game) => (
                          <button
                            key={game.key}
                            className={game.key === selectedGameKey ? 'sports-row active' : 'sports-row'}
                            aria-pressed={game.key === selectedGameKey}
                            onClick={() => setSelectedGameKey(game.key === selectedGameKey ? null : game.key)}
                          >
                            <span className="sports-row-label">
                              {game.homeDisplay} vs {game.awayDisplay}
                            </span>
                            <span className="sports-row-count">{feedCount(game.channels.length)}</span>
                          </button>
                        ))}
                      </>
                    )}
                  </>
                )}
              </div>
            </div>

            <div className="sports-col sports-feeds" style={{ width: feedsWidth }}>
              <div
                className="resize-handle resize-handle--col resize-handle--feeds"
                onPointerDown={startFeedsDrag}
                title="Drag to resize this panel"
              />
              <div className="sports-col-head">
                <span className="list-toolbar-title">
                  {selectedGame
                    ? `${selectedGame.homeDisplay} vs ${selectedGame.awayDisplay}`
                    : selectedLeague
                      ? `All ${selectedLeague.label} channels`
                      : 'Channels'}
                </span>
              </div>
              <div className="sports-list">
                {selectedGame ? (
                  selectedGame.channels.map((channel) => (
                    <button key={channel.stream_id} className="sports-row" onClick={() => selectChannel(channel)}>
                      <span className="sports-row-label">{channel.name}</span>
                      {channel.stream_icon ? (
                        <img className="sports-row-icon" src={channel.stream_icon} alt="" loading="lazy" />
                      ) : null}
                    </button>
                  ))
                ) : selectedLeague ? (
                  leagueCarrierChannels.length === 0 ? (
                    <div className="sports-empty">Select a game to list its channels.</div>
                  ) : (
                    leagueCarrierChannels.slice(0, MAX_ROWS).map((channel) => (
                      <button key={channel.stream_id} className="sports-row" onClick={() => selectChannel(channel)}>
                        <span className="sports-row-label">{channel.name}</span>
                        {channel.stream_icon ? (
                          <img className="sports-row-icon" src={channel.stream_icon} alt="" loading="lazy" />
                        ) : null}
                      </button>
                    ))
                  )
                ) : (
                  <div className="sports-empty">Select a game to list its channels.</div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

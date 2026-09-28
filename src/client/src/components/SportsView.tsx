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
  type SportsSport
} from '../lib/sports'
import { formatDualFromWall } from '../lib/gameTimes'
import type { Category, LiveStream } from '../lib/types'

// The Sports tab: the desktop sibling's (iptv-app 0.7.109 → 0.8.0), ported and re-arranged to the
// operator's own layout (2026-09-28):
//
//   [ sports ]  →  [ fixtures for the day, grouped by league ]  →  [ channels ]
//
// The tab is for FIXTURES; the channel integration is deliberately the last panel, reached by
// picking a fixture. Every row carries both kickoff clocks — the venue's wall clock and the
// browser's local one, as "3:00 pm (10:00 pm)" — and a match in play shows its score instead.
//
// The schedule itself comes from the provider's own catalogue through the pure lib/sports.ts;
// live scores come from api-football.com when a key is configured (see Admin → Sports data).

const DAY_RANGE = 7
// A handful of high-school/regional categories parse into thousands of games; rendering them all
// in one list would freeze the pane. The count is still shown so the size is honest.
const MAX_ROWS = 300
const PLAYER_MIN_HEIGHT = 120
const PLAYER_DEFAULT_MAX_HEIGHT = (): number => Math.round(window.innerHeight * 0.45)
const PLAYER_MAX_HEIGHT_CEILING = (): number => Math.round(window.innerHeight * 0.8)
// Per-view layout prefs (localStorage, the same mechanism the sidebar and EPG column use).
const PLAYER_MAX_HEIGHT_KEY = 'allisoniptv-sports-player-height'
const CHANNELS_WIDTH_KEY = 'allisoniptv-sports-channels-width'

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
  if (dayKey === dayKeyOf(new Date())) return 'Today'
  if (dayKey === dayKeyOf(new Date(Date.now() + 86_400_000))) return 'Tomorrow'
  return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })
}

/**
 * Kickoff as the operator asked for it: the venue's wall clock, then the browser's own clock in
 * brackets — "3:00 pm (10:00 pm)". When both zones read the same numbers only one is shown, since
 * a repeated identical time is noise rather than information.
 */
function formatKickoff(game: SportsGame, hour12: boolean): string {
  if (!game.kickoff) return 'Time TBD'
  if (!game.venueTime) return game.kickoff.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const dual = formatDualFromWall(
    game.venueTime.hour,
    game.venueTime.minute,
    game.venueTime.tzLabel,
    game.kickoff.getTime(),
    hour12
  )
  return dual.sameWall ? dual.venue : `${dual.venue} (${dual.local})`
}

function feedCount(count: number): string {
  return `${count} feed${count === 1 ? '' : 's'}`
}

export function SportsView({ session }: { session: Session }): JSX.Element {
  const [categories, setCategories] = useState<Category[]>([])
  const [streams, setStreams] = useState<LiveStream[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [selectedSportId, setSelectedSportId] = useState<string | null>(null)
  const [dayOffset, setDayOffset] = useState(0)
  const [selectedGameKey, setSelectedGameKey] = useState<string | null>(null)
  const [nowPlaying, setNowPlaying] = useState<LiveStream | null>(null)
  // The schedule buckets games by day, so it is built once against a fixed "now"; the day *picker*
  // below uses the live clock, which is what "Today" means to a viewer.
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
  const { dimension: channelsWidth, startDrag: startChannelsDrag } = useResizableDimension(
    loadSavedDimension(CHANNELS_WIDTH_KEY, 320, 220, 640),
    'x',
    { min: 220, max: 640, onCommit: (w) => saveDimension(CHANNELS_WIDTH_KEY, w) }
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
  // comment in lib/sports.ts. A category that fails to load contributes nothing rather than
  // failing the tab.
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

  // Land on the biggest sport so the tab is useful immediately rather than showing a prompt.
  useEffect(() => {
    if (selectedSportId === null && schedule && schedule.sports.length > 0) {
      setSelectedSportId(schedule.sports[0].id)
    }
  }, [schedule, selectedSportId])

  const selectedSport: SportsSport | null = schedule?.sports.find((s) => s.id === selectedSportId) ?? null
  const sportLeagues = useMemo(
    () => (selectedSport ? selectedSport.leagueIds.map((id) => schedule?.leagues.find((l) => l.id === id)).filter((l): l is NonNullable<typeof l> => Boolean(l)) : []),
    [selectedSport, schedule]
  )

  const dayKey = dayKeyOf(new Date(Date.now() + dayOffset * 86_400_000))
  // The selected sport's games for the chosen day, grouped by the league they belong to (the
  // league order the schedule already sorted: football first, then by size).
  const gamesByLeagueForDay = useMemo(() => {
    const out: Array<{ league: (typeof sportLeagues)[number]; games: SportsGame[] }> = []
    for (const league of sportLeagues) {
      const all = schedule?.gamesByLeague[league.id] ?? []
      const games = gamesForDay(all, dayKey)
      if (games.length > 0) out.push({ league, games })
    }
    return out
  }, [sportLeagues, schedule, dayKey])

  const unscheduledByLeague = useMemo(() => {
    const out: Array<{ league: (typeof sportLeagues)[number]; games: SportsGame[] }> = []
    for (const league of sportLeagues) {
      const games = (schedule?.gamesByLeague[league.id] ?? []).filter((g) => g.dayKey === null)
      if (games.length > 0) out.push({ league, games })
    }
    return out
  }, [sportLeagues, schedule])

  const allGames = useMemo(() => sportLeagues.flatMap((l) => schedule?.gamesByLeague[l.id] ?? []), [sportLeagues, schedule])
  const selectedGame = allGames.find((g) => g.key === selectedGameKey) ?? null

  // Panel 3's default: every channel the provider carries in a sports category, so a channel is
  // still reachable when no fixture is selected.
  const allSportsChannels = useMemo(
    () => [...streams].sort((a, b) => a.name.localeCompare(b.name)),
    [streams]
  )

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
  const dayCount = gamesByLeagueForDay.reduce((n, group) => n + group.games.length, 0)

  return (
    <div className="app-body">
      <nav className="sidebar" style={{ width: sidebarWidth }} aria-label="Sports">
        <div className="sidebar-section-label">Sports</div>
        {(schedule?.sports ?? []).map((sport) => (
          <button
            key={sport.id}
            className={sport.id === selectedSportId ? 'category-btn active' : 'category-btn'}
            onClick={() => {
              setSelectedSportId(sport.id)
              setSelectedGameKey(null)
            }}
            title={`${sport.label} — ${sport.leagueIds.length} competition${sport.leagueIds.length === 1 ? '' : 's'}`}
          >
            {sport.label}
          </button>
        ))}
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
                <span className="list-toolbar-title">{selectedSport?.label ?? 'Fixtures'}</span>
                <span className="sports-head-sub">
                  {dayCount} fixture{dayCount === 1 ? '' : 's'}
                </span>
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
              </div>

              <div className="sports-list">
                {gamesByLeagueForDay.length === 0 && unscheduledByLeague.length === 0 && (
                  <div className="sports-empty">
                    No {selectedSport?.label.toLowerCase() ?? 'sporting'} fixtures on {formatDayLabel(dayKey).toLowerCase()}.
                  </div>
                )}
                {gamesByLeagueForDay.map(({ league, games }) => (
                  <div key={league.id}>
                    <div className="sports-section">{league.label}</div>
                    {games.slice(0, MAX_ROWS).map((game) => (
                      <button
                        key={game.key}
                        className={game.key === selectedGameKey ? 'sports-row active' : 'sports-row'}
                        aria-pressed={game.key === selectedGameKey}
                        onClick={() => setSelectedGameKey(game.key === selectedGameKey ? null : game.key)}
                        title={`${formatKickoff(game, hour12)} · ${feedCount(game.channels.length)} carry this fixture`}
                      >
                        <span className="sports-row-label">
                          {game.homeDisplay} vs {game.awayDisplay}
                          <span className="sports-row-time">{formatKickoff(game, hour12)}</span>
                        </span>
                        <span className="sports-row-count">{feedCount(game.channels.length)}</span>
                      </button>
                    ))}
                    {games.length > MAX_ROWS && (
                      <div className="sports-empty">…and {games.length - MAX_ROWS} more fixtures</div>
                    )}
                  </div>
                ))}
                {unscheduledByLeague.map(({ league, games }) => (
                  <div key={`unscheduled-${league.id}`}>
                    <div className="sports-section">{league.label} · unscheduled</div>
                    {games.slice(0, MAX_ROWS).map((game) => (
                      <button
                        key={game.key}
                        className={game.key === selectedGameKey ? 'sports-row active' : 'sports-row'}
                        aria-pressed={game.key === selectedGameKey}
                        onClick={() => setSelectedGameKey(game.key === selectedGameKey ? null : game.key)}
                      >
                        <span className="sports-row-label">
                          {game.homeDisplay} vs {game.awayDisplay}
                          <span className="sports-row-time">Time TBD</span>
                        </span>
                        <span className="sports-row-count">{feedCount(game.channels.length)}</span>
                      </button>
                    ))}
                  </div>
                ))}
              </div>
            </div>

            <div className="sports-col sports-feeds" style={{ width: channelsWidth }}>
              <div
                className="resize-handle resize-handle--col resize-handle--feeds"
                onPointerDown={startChannelsDrag}
                title="Drag to resize this panel"
              />
              <div className="sports-col-head">
                <span className="list-toolbar-title">
                  {selectedGame ? `${selectedGame.homeDisplay} vs ${selectedGame.awayDisplay}` : 'Channels'}
                </span>
                <span className="sports-head-sub">
                  {selectedGame ? formatKickoff(selectedGame, hour12) : `${allSportsChannels.length} channels`}
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
                ) : allSportsChannels.length === 0 ? (
                  <div className="sports-empty">No sports channels on this provider.</div>
                ) : (
                  <>
                    <div className="sports-section">All sports channels</div>
                    {allSportsChannels.slice(0, MAX_ROWS).map((channel) => (
                      <button key={channel.stream_id} className="sports-row" onClick={() => selectChannel(channel)}>
                        <span className="sports-row-label">{channel.name}</span>
                        {channel.stream_icon ? (
                          <img className="sports-row-icon" src={channel.stream_icon} alt="" loading="lazy" />
                        ) : null}
                      </button>
                    ))}
                  </>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

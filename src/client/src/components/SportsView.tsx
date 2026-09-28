import { useCallback, useEffect, useMemo, useState, type CSSProperties, type JSX, type ReactNode } from 'react'
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
  sportOfLeague,
  type SportsGame,
  type SportsGroup,
  type SportsSport
} from '../lib/sports'
import { formatDualFromInstant, formatDualFromWall, venueTimezoneForCountry } from '../lib/gameTimes'
import {
  channelsMentioningTeams,
  fetchFixtures,
  fetchSportsConfig,
  matchFixturesToGames,
  type ApiFootballFixture
} from '../lib/sportsFixtures'
import { fetchSportsCatalogue } from '../lib/sportsCatalogue'
import { parseCollapsedGroups, serializeCollapsedGroups, toggleCollapsedGroup } from '../lib/sportsGroups'
import type { Category, LiveStream } from '../lib/types'

// The Sports tab: the desktop sibling's (iptv-app 0.7.109 → 0.8.0), ported and re-arranged to the
// operator's own layout (2026-09-28):
//
//   [ sports ]  →  [ fixtures for the day, grouped by league ]  →  [ channels ]
//
// The tab is for FIXTURES; the channel integration is deliberately the last panel, reached by
// picking a fixture. Every row carries both kickoff clocks — the venue's wall clock and the
// browser's own, as "3:00 pm (10:00 pm)" — and a match in play shows its score instead.
//
// The schedule comes from the provider's own catalogue through the pure lib/sports.ts; the day's
// **fixtures and scores** come from api-football.com when a key is configured (Admin → Sports
// data). The two are paired, exactly then loosely, so a fixture reaches the channels carrying it;
// a fixture the provider does not carry is still listed, and selecting it searches the catalogue
// for a channel that mentions either team.

const DAY_RANGE = 7
// A handful of high-school/regional categories parse into thousands of games; rendering them all
// in one list would freeze the pane. The count is still shown so the size is honest.
const MAX_ROWS = 300
const PLAYER_MIN_HEIGHT = 120
const PLAYER_DEFAULT_MAX_HEIGHT = (): number => Math.round(window.innerHeight * 0.45)
const PLAYER_MAX_HEIGHT_CEILING = (): number => Math.round(window.innerHeight * 0.8)
// Per-view layout prefs (localStorage, the same mechanism the sidebar and EPG column use).
const PLAYER_MAX_HEIGHT_KEY = 'allison-web-iptv:sports-player-max-height'
const CHANNELS_WIDTH_KEY = 'allison-web-iptv:sports-channels-width'

// Which competition groups the fixtures pane is showing collapsed, remembered per device.
const COLLAPSED_GROUPS_KEY = 'allison-web-iptv:sports-collapsed-leagues'

type Selection = { kind: 'game'; key: string } | { kind: 'fixture'; id: number }

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

/** The venue's wall clock with the browser's own in brackets — "3:00 pm (10:00 pm)". */
function dualClock(venue: string, local: string, sameWall: boolean): string {
  return sameWall ? venue : `${venue} (${local})`
}

/** A provider fixture's kickoff, from the wall time its channel name carries. */
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
  return dualClock(dual.venue, dual.local, dual.sameWall)
}

/** The score line for a fixture whose feed has one — in play first, then full time. */
function scoreLine(fixture: ApiFootballFixture | undefined): { text: string; live: boolean } | null {
  if (!fixture) return null
  const hasScore = fixture.homeGoals !== null && fixture.awayGoals !== null
  if (fixture.live) return { text: hasScore ? `Live ${fixture.homeGoals}-${fixture.awayGoals}` : 'Live', live: true }
  if (fixture.finished && hasScore) return { text: `FT ${fixture.homeGoals}-${fixture.awayGoals}`, live: false }
  return null
}

/** An api-football fixture's status line: its score when there is one, else both clocks. */
function fixtureStatus(fixture: ApiFootballFixture, hour12: boolean): { text: string; live: boolean } {
  const score = scoreLine(fixture)
  if (score) return score
  if (fixture.kickoffMs === null) return { text: 'Time TBD', live: false }
  const dual = formatDualFromInstant(fixture.kickoffMs, venueTimezoneForCountry(fixture.country), hour12)
  return { text: dualClock(dual.venue, dual.local, dual.sameWall), live: false }
}

/** Which sport an api-football fixture's competition belongs to, or null when it is not a sport. */
function fixtureSportId(fixture: ApiFootballFixture): string | null {
  const cls = classifyCategory(fixture.league)
  return cls?.kind === 'league' ? sportOfLeague(cls.rule.id) : null
}

/**
 * The collapsed groups for this device. Storage can throw in private modes — a view pref is not
 * worth failing a render over, exactly as the resizable-panel helpers treat it.
 */
function loadCollapsedGroups(): Set<string> {
  try {
    return parseCollapsedGroups(window.localStorage.getItem(COLLAPSED_GROUPS_KEY))
  } catch {
    return new Set()
  }
}

function saveCollapsedGroups(groups: Set<string>): void {
  try {
    window.localStorage.setItem(COLLAPSED_GROUPS_KEY, serializeCollapsedGroups(groups))
  } catch {
    // See loadCollapsedGroups.
  }
}

/**
 * One collapsible competition group in the fixtures pane.
 *
 * The header is a real button, so it is reachable by keyboard, and `aria-expanded` says what it
 * does. Collapsing is remembered per league (see lib/sportsGroups.ts), so a group a viewer keeps
 * shut — a regional competition they never watch — stays shut on the next visit.
 */
function LeagueGroup({
  id,
  bodyId,
  label,
  note,
  count,
  collapsed,
  onToggle,
  children
}: {
  id: string
  bodyId: string
  label: string
  note?: string
  count: number
  collapsed: boolean
  onToggle: (id: string) => void
  children: ReactNode
}): JSX.Element {
  return (
    <div className="sports-group">
      <button
        type="button"
        className={collapsed ? 'sports-group-head collapsed' : 'sports-group-head'}
        aria-expanded={!collapsed}
        aria-controls={bodyId}
        onClick={() => onToggle(id)}
        title={collapsed ? 'Show these fixtures' : 'Hide these fixtures'}
      >
        <span className="sports-group-chevron" aria-hidden="true">
          {collapsed ? '▸' : '▾'}
        </span>
        <span className="sports-group-label">{label}</span>
        {note ? <span className="sports-section-note">{note}</span> : null}
        <span className="sports-group-count">
          {count} {count === 1 ? 'fixture' : 'fixtures'}
        </span>
      </button>
      {!collapsed && <div id={bodyId}>{children}</div>}
    </div>
  )
}

function feedCount(count: number): string {
  return `${count} feed${count === 1 ? '' : 's'}`
}

/** One row of the fixtures pane — a provider game (with channels) or a fixture it does not carry. */
function FixtureRow({
  selected,
  onToggle,
  title,
  matchup,
  status,
  trailing,
  trailingWarn
}: {
  selected: boolean
  onToggle: () => void
  title: string
  matchup: string
  status: { text: string; live: boolean }
  trailing: string
  trailingWarn?: boolean
}): JSX.Element {
  return (
    <button
      className={selected ? 'sports-row active' : 'sports-row'}
      aria-pressed={selected}
      onClick={onToggle}
      title={title}
    >
      <span className="sports-row-label">
        {matchup}
        <span className={status.live ? 'sports-row-time sports-row-time--live' : 'sports-row-time'}>{status.text}</span>
      </span>
      <span className={trailingWarn ? 'sports-row-count sports-row-count--warn' : 'sports-row-count'}>{trailing}</span>
    </button>
  )
}

/** A channel row, used in the channels pane. */
function ChannelRow({ channel, onPlay }: { channel: LiveStream; onPlay: (channel: LiveStream) => void }): JSX.Element {
  return (
    <button className="sports-row" onClick={() => onPlay(channel)}>
      <span className="sports-row-label">{channel.name}</span>
      {channel.stream_icon ? <img className="sports-row-icon" src={channel.stream_icon} alt="" loading="lazy" /> : null}
    </button>
  )
}

export function SportsView({ session }: { session: Session }): JSX.Element {
  const [categories, setCategories] = useState<Category[]>([])
  const [streams, setStreams] = useState<LiveStream[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [selectedSportId, setSelectedSportId] = useState<string | null>(null)
  const [dayOffset, setDayOffset] = useState(0)
  const [selection, setSelection] = useState<Selection | null>(null)
  // Which competition groups are collapsed, per device (see lib/sportsGroups.ts).
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(loadCollapsedGroups)
  const [nowPlaying, setNowPlaying] = useState<LiveStream | null>(null)
  // The schedule buckets games by day, so it is built once against a fixed "now"; the day *picker*
  // below uses the live clock, which is what "Today" means to a viewer.
  const [builtAt] = useState(() => new Date())
  // Live scores and the day's fixtures (api-football.com). `keySet === null` means "not asked yet";
  // false is a normal state — the schedule works without it, only the fixtures feed is absent.
  const [fixtures, setFixtures] = useState<ApiFootballFixture[]>([])
  const [keySet, setKeySet] = useState<boolean | null>(null)
  const [fixturesError, setFixturesError] = useState<string | null>(null)

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
    // invert: this pane sits to the RIGHT of its handle, so dragging left must widen it.
    { min: 220, max: 640, invert: true, onCommit: (w) => saveDimension(CHANNELS_WIDTH_KEY, w) }
  )

  // The provider's categories, from the server's shared, once-a-day catalogue cache — opening this
  // tab must not re-fetch the provider's list, and a restart must not either.
  useEffect(() => {
    void fetchSportsCatalogue()
      .then((result) => setCategories(result.categories))
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
    void fetchSportsCatalogue(sportsCategoryIds)
      .then((result) => {
        if (cancelled) return
        setStreams(result.streams)
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
  }, [sportsCategoryIds])

  useEffect(() => {
    reportNowPlaying(nowPlaying?.name ?? null, 'live')
  }, [nowPlaying])
  useEffect(() => () => reportNowPlaying(null), [])

  // The key's presence, not the key itself: it lives on the server and is never sent here.
  useEffect(() => {
    void fetchSportsConfig()
      .then(({ keySet: present }) => setKeySet(present))
      .catch(() => setKeySet(false))
  }, [])

  const dayKey = dayKeyOf(new Date(Date.now() + dayOffset * 86_400_000))

  // A day's fixtures, for the scores. Five minutes matches the feed's own refetch cadence, which is
  // what keeps a live score honest without spending a free-tier quota on every render.
  useEffect(() => {
    if (!keySet) return
    let cancelled = false
    const load = (): void => {
      void fetchFixtures(dayKey)
        .then((result) => {
          if (cancelled) return
          setFixtures(result.fixtures)
          setFixturesError(result.error)
        })
        .catch((err) => {
          if (cancelled) return
          setFixtures([])
          setFixturesError(err instanceof Error ? err.message : 'Could not load fixtures')
        })
    }
    load()
    const timer = window.setInterval(load, 300_000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [keySet, dayKey])

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
    () =>
      selectedSport
        ? selectedSport.leagueIds
            .map((id) => schedule?.leagues.find((l) => l.id === id))
            .filter((l): l is SportsGroup => Boolean(l))
        : [],
    [selectedSport, schedule]
  )

  const sportGamesForDay = useMemo(() => {
    const out: Array<{ league: SportsGroup; games: SportsGame[] }> = []
    for (const league of sportLeagues) {
      const games = gamesForDay(schedule?.gamesByLeague[league.id] ?? [], dayKey)
      if (games.length > 0) out.push({ league, games })
    }
    return out
  }, [sportLeagues, schedule, dayKey])

  const sportUnscheduled = useMemo(() => {
    const out: Array<{ league: SportsGroup; games: SportsGame[] }> = []
    for (const league of sportLeagues) {
      const games = (schedule?.gamesByLeague[league.id] ?? []).filter((g) => g.dayKey === null)
      if (games.length > 0) out.push({ league, games })
    }
    return out
  }, [sportLeagues, schedule])

  const dayGames = useMemo(() => sportGamesForDay.flatMap((group) => group.games), [sportGamesForDay])

  // The day's fixtures for this sport, paired with the provider's own rows: exactly first, then
  // loosely (see lib/sportsFixtures.ts). Anything left unpaired is a fixture the provider does not
  // carry under a recognisable name — still listed, and clickable to search for a channel.
  // **api-football's own list is what the pane shows** when the feed is available — the operator's
  // ask (2026-09-28): the schedules are the API's, grouped by ITS competitions ("English Premier
  // League"), not by the provider's channel-name buckets, which produced a pointless
  // "Football › Football". Without a key, or if the feed fails, the pane falls back to the
  // provider's own schedule so the tab is never empty.
  const apiMode = keySet === true && fixturesError === null
  const sportFixturesForDay = useMemo(
    () => fixtures.filter((fixture) => fixtureSportId(fixture) === selectedSportId),
    [fixtures, selectedSportId]
  )

  // Each fixture paired to the provider row that carries it — exactly, then loosely
  // (lib/sportsFixtures.ts) — which is what makes selecting a fixture lead to its channels.
  const pairing = useMemo(
    () => matchFixturesToGames(sportFixturesForDay, dayGames.map((game) => ({ key: game.key, pairKey: game.pairKey }))),
    [sportFixturesForDay, dayGames]
  )
  const gameByFixtureId = useMemo(() => {
    const byKey = new Map(dayGames.map((game) => [game.key, game]))
    const map = new Map<number, SportsGame>()
    for (const [gameKey, fixture] of pairing.byGame) {
      const game = byKey.get(gameKey)
      if (game) map.set(fixture.id, game)
    }
    return map
  }, [pairing, dayGames])

  // The pane's grouping: one group per competition, live matches first and then by kickoff, with
  // the competitions ordered by name so the list is stable between days.
  const apiGroups = useMemo(() => {
    const byLeague = new Map<string, { league: string; country: string; fixtures: ApiFootballFixture[] }>()
    for (const fixture of sportFixturesForDay) {
      const key = fixture.league || 'Other fixtures'
      const group = byLeague.get(key) ?? { league: fixture.league || 'Other fixtures', country: fixture.country, fixtures: [] }
      group.fixtures.push(fixture)
      byLeague.set(key, group)
    }
    const groups = [...byLeague.values()]
    for (const group of groups) {
      group.fixtures.sort((a, b) => {
        if (a.live !== b.live) return a.live ? -1 : 1
        return (a.kickoffMs ?? Number.POSITIVE_INFINITY) - (b.kickoffMs ?? Number.POSITIVE_INFINITY)
      })
    }
    return groups.sort((a, b) => a.league.localeCompare(b.league))
  }, [sportFixturesForDay])

  const selectedGameKey = selection?.kind === 'game' ? selection.key : null
  const selectedFixtureId = selection?.kind === 'fixture' ? selection.id : null
  const selectedGame = dayGames.find((game) => game.key === selectedGameKey) ?? null
  const selectedFixture = sportFixturesForDay.find((fixture) => fixture.id === selectedFixtureId) ?? null
  // When the fixture's channels are known, the third pane lists them rather than searching.
  const selectedFixtureGame = selectedFixture ? (gameByFixtureId.get(selectedFixture.id) ?? null) : null

  // Panel 3's fallback candidate list, only computed when a selected fixture has no matched channel.
  const fixtureCandidates = useMemo(
    () =>
      selectedFixture && !selectedFixtureGame
        ? channelsMentioningTeams(streams, selectedFixture.homeTeam, selectedFixture.awayTeam)
        : [],
    [selectedFixture, selectedFixtureGame, streams]
  )

  // Panel 3's default: every channel the provider carries in a sports category, so a channel is
  // still reachable when no fixture is selected.
  const allSportsChannels = useMemo(() => [...streams].sort((a, b) => a.name.localeCompare(b.name)), [streams])

  const playChannel = useCallback((channel: LiveStream): void => {
    setNowPlaying(channel)
  }, [])

  const toggleGame = useCallback((key: string): void => {
    setSelection((current) => (current?.kind === 'game' && current.key === key ? null : { kind: 'game', key }))
  }, [])
  const toggleFixture = useCallback((id: number): void => {
    setSelection((current) => (current?.kind === 'fixture' && current.id === id ? null : { kind: 'fixture', id }))
  }, [])
  const toggleGroup = useCallback((id: string): void => {
    setCollapsedGroups((current) => {
      const next = toggleCollapsedGroup(current, id)
      saveCollapsedGroups(next)
      return next
    })
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
  const dayCount = apiMode ? sportFixturesForDay.length : dayGames.length

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
              setSelection(null)
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
                {apiMode ? (
                  <span className="sports-head-hint" title="Fixtures and scores come from api-football.com">
                    via api-football.com
                  </span>
                ) : keySet === false ? (
                  <span className="sports-head-hint" title="Set an api-football.com key in Admin → Sports data">
                    Add a key for live scores
                  </span>
                ) : null}
                {fixturesError && (
                  <span className="sports-head-hint sports-head-hint--warn" title={fixturesError}>
                    Scores unavailable
                  </span>
                )}
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
                {apiMode
                  ? apiGroups.length === 0 && (
                      <div className="sports-empty">
                        No {selectedSport?.label.toLowerCase() ?? 'sporting'} fixtures on{' '}
                        {formatDayLabel(dayKey).toLowerCase()}.
                      </div>
                    )
                  : dayGames.length === 0 &&
                    sportUnscheduled.length === 0 && (
                      <div className="sports-empty">
                        No {selectedSport?.label.toLowerCase() ?? 'sporting'} fixtures on{' '}
                        {formatDayLabel(dayKey).toLowerCase()}.
                      </div>
                    )}

                {/* The feed's own competitions — "English Premier League", not the provider's
                    channel buckets. Each fixture pairs to the provider row carrying it, so
                    selecting one leads to its channels. */}
                {apiMode &&
                  apiGroups.map((group, index) => (
                    <LeagueGroup
                      key={group.league}
                      id={`api-league-${group.league}`}
                      bodyId={`sports-league-${index}`}
                      label={group.league}
                      note={group.country || undefined}
                      count={group.fixtures.length}
                      collapsed={collapsedGroups.has(`api-league-${group.league}`)}
                      onToggle={toggleGroup}
                    >
                      {group.fixtures.slice(0, MAX_ROWS).map((fixture) => {
                        const game = gameByFixtureId.get(fixture.id) ?? null
                        return (
                          <FixtureRow
                            key={`fixture-${fixture.id}`}
                            selected={fixture.id === selectedFixtureId}
                            onToggle={() => toggleFixture(fixture.id)}
                            matchup={`${fixture.homeTeam} vs ${fixture.awayTeam}`}
                            status={fixtureStatus(fixture, hour12)}
                            trailing={game ? feedCount(game.channels.length) : 'no channel'}
                            trailingWarn={!game}
                            title={
                              game
                                ? `${fixture.league} — ${feedCount(game.channels.length)} carry this fixture`
                                : `${fixture.league} (${fixture.country}) — no channel on your provider names this fixture; select it to search`
                            }
                          />
                        )
                      })}
                    </LeagueGroup>
                  ))}

                {!apiMode &&
                  sportGamesForDay.map(({ league, games }, index) => (
                  <LeagueGroup
                    key={league.id}
                    id={`provider-${league.id}`}
                    bodyId={`sports-provider-${index}`}
                    label={league.label}
                    count={games.length}
                    collapsed={collapsedGroups.has(`provider-${league.id}`)}
                    onToggle={toggleGroup}
                  >
                    {games.slice(0, MAX_ROWS).map((game) => (
                      <FixtureRow
                        key={game.key}
                        selected={game.key === selectedGameKey}
                        onToggle={() => toggleGame(game.key)}
                        matchup={`${game.homeDisplay} vs ${game.awayDisplay}`}
                        status={
                          scoreLine(pairing.byGame.get(game.key)) ?? { text: formatKickoff(game, hour12), live: false }
                        }
                        trailing={feedCount(game.channels.length)}
                        title={`${formatKickoff(game, hour12)} · ${feedCount(game.channels.length)} carry this fixture`}
                      />
                    ))}
                    {games.length > MAX_ROWS && (
                      <div className="sports-empty">…and {games.length - MAX_ROWS} more fixtures</div>
                    )}
                  </LeagueGroup>
                ))}

                {!apiMode &&
                  sportUnscheduled.map(({ league, games }, index) => (
                  <LeagueGroup
                    key={`unscheduled-${league.id}`}
                    id={`unscheduled-${league.id}`}
                    bodyId={`sports-unscheduled-${index}`}
                    label={`${league.label} · unscheduled`}
                    count={games.length}
                    collapsed={collapsedGroups.has(`unscheduled-${league.id}`)}
                    onToggle={toggleGroup}
                  >
                    {games.slice(0, MAX_ROWS).map((game) => (
                      <FixtureRow
                        key={game.key}
                        selected={game.key === selectedGameKey}
                        onToggle={() => toggleGame(game.key)}
                        matchup={`${game.homeDisplay} vs ${game.awayDisplay}`}
                        status={scoreLine(pairing.byGame.get(game.key)) ?? { text: 'Time TBD', live: false }}
                        trailing={feedCount(game.channels.length)}
                        title={`${feedCount(game.channels.length)} carry this fixture`}
                      />
                    ))}
                  </LeagueGroup>
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
                  {selectedGame
                    ? `${selectedGame.homeDisplay} vs ${selectedGame.awayDisplay}`
                    : selectedFixture
                      ? `${selectedFixture.homeTeam} vs ${selectedFixture.awayTeam}`
                      : 'Channels'}
                </span>
                <span className="sports-head-sub">
                  {selectedGame
                    ? (scoreLine(pairing.byGame.get(selectedGame.key))?.text ?? formatKickoff(selectedGame, hour12))
                    : selectedFixture
                      ? fixtureStatus(selectedFixture, hour12).text
                      : `${allSportsChannels.length} channels`}
                </span>
              </div>
              <div className="sports-list">
                {selectedGame ? (
                  selectedGame.channels.map((channel) => (
                    <ChannelRow key={channel.stream_id} channel={channel} onPlay={playChannel} />
                  ))
                ) : selectedFixture && selectedFixtureGame ? (
                  selectedFixtureGame.channels.map((channel) => (
                    <ChannelRow key={channel.stream_id} channel={channel} onPlay={playChannel} />
                  ))
                ) : selectedFixture ? (
                  <>
                    <div className="sports-callout">
                      No channel on your provider names this fixture
                      {fixtureCandidates.length > 0
                        ? ' — but these mention one of the teams. Worth a look:'
                        : '. Nothing in the catalogue mentions either team either.'}
                    </div>
                    {fixtureCandidates.slice(0, MAX_ROWS).map((channel) => (
                      <ChannelRow key={channel.stream_id} channel={channel} onPlay={playChannel} />
                    ))}
                  </>
                ) : allSportsChannels.length === 0 ? (
                  <div className="sports-empty">No sports channels on this provider.</div>
                ) : (
                  <>
                    <div className="sports-section">All sports channels</div>
                    {allSportsChannels.slice(0, MAX_ROWS).map((channel) => (
                      <ChannelRow key={channel.stream_id} channel={channel} onPlay={playChannel} />
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


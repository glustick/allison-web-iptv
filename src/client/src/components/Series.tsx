import { useCallback, useEffect, useMemo, useState, type JSX } from 'react'
import type { Session } from '../lib/appAuth'
import { reportNowPlaying } from '../lib/activityReporter'
import { NativeVideoPlayer } from './NativeVideoPlayer'
import { useSidebarWidth } from '../lib/useSidebarWidth'
import { formatClock } from './Movies'
import { XtreamClient } from '../lib/xtreamClient'
import { playlistRefOf } from '../lib/types'
import {
  clearResumePosition,
  setFavourite,
  fetchPrefs,
  recordHistory,
  setResumePosition,
  type PrefsState,
  type ResumePosition
} from '../lib/prefs'
import type { Category, SeriesItem, SeriesInfo, SeriesEpisode } from '../lib/types'

const EMPTY_PREFS: PrefsState = { favourites: [], categories: [], history: [], resume: [] }

type Selection = { type: 'all' } | { type: 'favourites' } | { type: 'provider'; id: string } | { type: 'history' }

interface AdditionalVod {
  id: string
  label: string
  categories: Category[]
  error: string | null
}

/** Reads the shared per-playlist hide list (LiveTv's own pref) so a playlist hidden in the grid
 *  stays hidden here — one concept, no second toggle to keep in sync. */
function readHiddenPlaylists(): string[] {
  try {
    const raw = localStorage.getItem('iptv:playlist-view')
    if (!raw) return []
    const parsed = JSON.parse(raw) as { hidden?: unknown }
    return Array.isArray(parsed.hidden) ? parsed.hidden.filter((id): id is string => typeof id === 'string') : []
  } catch {
    return []
  }
}

/** Resuming an episode is the whole point of tracking series progress: the position is keyed by
 *  episode id, so each episode in a season keeps its own place. Since v0.79.0 the key is the
 *  composite (playlist, episode id) — episode ids are provider-scoped like everything else. */
function ResumeControls({
  resume,
  onResume,
  onStartOver
}: {
  resume: ResumePosition
  onResume: () => void
  onStartOver: () => void
}): JSX.Element {
  const percent = resume.durationSeconds ? Math.min(100, Math.round((resume.positionSeconds / resume.durationSeconds) * 100)) : null
  return (
    <>
      <span className="resume-badge">
        {percent !== null ? `${percent}% · ` : ''}
        {formatClock(resume.positionSeconds)}
      </span>
      <button type="button" className="admin-small-btn" onClick={onResume}>
        Resume
      </button>
      <button type="button" className="admin-small-btn" onClick={onStartOver}>
        Start over
      </button>
    </>
  )
}

function EpisodeList({
  client,
  seriesId,
  resumeFor,
  onPlay
}: {
  /** The scoped client for whichever playlist this series belongs to (v0.79.0). */
  client: XtreamClient
  seriesId: number
  resumeFor: (episodeId: number) => ResumePosition | undefined
  onPlay: (episode: SeriesEpisode, resumeFrom: number) => void
}): JSX.Element {
  const [info, setInfo] = useState<SeriesInfo | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setInfo(null)
    client
      .getSeriesInfo(seriesId)
      .then(setInfo)
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load episodes'))
  }, [client, seriesId])

  if (error) return <div className="login-error" style={{ padding: '8px 16px' }}>{error}</div>
  if (!info) return <div className="now-playing-bar">Loading episodes…</div>

  // `seasons` is unreliable — confirmed live against a real title on the real account this
  // project's own test account uses ("Meteor (2009)"): the provider returned an empty
  // `seasons` array while `episodes` still had real content keyed by season number. Deriving
  // the season list from `episodes`' own keys instead works regardless of whether a given
  // provider bothers to populate `seasons` at all; `info.seasons` is only consulted for a
  // nicer display name when one happens to be there for a season that also has episodes.
  const seasonNumbers = Object.keys(info.episodes)
    .map(Number)
    .filter((n) => (info.episodes[String(n)]?.length ?? 0) > 0)
    .sort((a, b) => a - b)

  return (
    <div className="channel-list">
      {seasonNumbers.map((seasonNumber) => (
        <div key={seasonNumber}>
          <div className="now-playing-bar">
            {info.seasons.find((s) => s.season_number === seasonNumber)?.name || `Season ${seasonNumber}`}
          </div>
          {(info.episodes[String(seasonNumber)] ?? []).map((episode) => {
            const resume = resumeFor(Number(episode.id))
            return (
              <div key={episode.id} className="channel-row-wrap">
                <button className="channel-row" onClick={() => onPlay(episode, resume?.positionSeconds ?? 0)}>
                  <span>
                    {episode.episode_num}. {episode.title}
                  </span>
                </button>
                {resume && (
                  <ResumeControls
                    resume={resume}
                    onResume={() => onPlay(episode, resume.positionSeconds)}
                    onStartOver={() => onPlay(episode, 0)}
                  />
                )}
              </div>
            )
          })}
        </div>
      ))}
    </div>
  )
}

export function Series({
  session,
  playRequest,
  onPlayHandled
}: {
  session: Session
  playRequest?: { kind: string; streamId: number; name: string; playlistId?: string; nonce: number } | null
  onPlayHandled?: () => void
}): JSX.Element {
  const [categories, setCategories] = useState<Category[]>([])
  const [selectedCategoryId, setSelectedCategoryId] = useState<string | null>(null)
  const [seriesList, setSeriesList] = useState<SeriesItem[]>([])
  const [openSeries, setOpenSeries] = useState<SeriesItem | null>(null)
  // Series favourites: prefs already stores them (kind 'series'); this tab just never showed them.
  const [nowPlaying, setNowPlaying] = useState<{ episode: SeriesEpisode; playlistId?: string } | null>(null)
  const [startAt, setStartAt] = useState(0)
  const [loadError, setLoadError] = useState<string | null>(null)
  // True once the category fetch has *answered* — an empty catalogue that arrived as an answer is
  // the provider's to explain, and it deserves a sentence rather than a silently bare sidebar.
  const [categoriesAnswered, setCategoriesAnswered] = useState(false)
  const [selection, setSelection] = useState<Selection>({ type: 'all' })
  const [prefs, setPrefs] = useState<PrefsState>(EMPTY_PREFS)
  const seriesFavourites = useMemo(() => prefs.favourites.filter((f) => f.kind === 'series'), [prefs.favourites])
  const { sidebarWidth, startSidebarDrag } = useSidebarWidth()

  // --- additional playlists (v0.79.0), the Movies/LiveTv pattern ---------------------------
  const [additional, setAdditional] = useState<AdditionalVod[]>([])
  const [hidden, setHidden] = useState<string[]>(readHiddenPlaylists)
  const [playlistSelected, setPlaylistSelected] = useState<string>('primary')
  useEffect(() => {
    let active = true
    fetch('/api/iptv/playlists')
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return (await res.json()) as { playlists?: Array<{ id: string; label: string }> }
      })
      .then(async (body) => {
        const saved = (body.playlists ?? []).filter((p) => p.id !== 'primary')
        if (!active) return
        setAdditional(saved.map((p) => ({ id: p.id, label: p.label, categories: [], error: null })))
        await Promise.all(
          saved.map(async (p) => {
            try {
              const list = await new XtreamClient(p.id).getSeriesCategories()
              if (!active) return
              setAdditional((prev) =>
                prev.map((entry) => (entry.id === p.id ? { ...entry, categories: list, error: null } : entry))
              )
            } catch (err) {
              if (!active) return
              setAdditional((prev) =>
                prev.map((entry) =>
                  entry.id === p.id
                    ? { ...entry, error: err instanceof Error ? err.message : 'Could not load this playlist' }
                    : entry
                )
              )
            }
          })
        )
      })
      .catch(() => {
        // The primary keeps working; the chips simply don't appear.
      })
    const onStorage = (): void => setHidden(readHiddenPlaylists())
    window.addEventListener('storage', onStorage)
    return () => {
      active = false
      window.removeEventListener('storage', onStorage)
    }
  }, [])

  const visibleAdditional = useMemo(
    () => additional.filter((entry) => !hidden.includes(entry.id)),
    [additional, hidden]
  )

  useEffect(() => {
    fetchPrefs()
      .then(setPrefs)
      .catch((err) => setLoadError(err instanceof Error ? err.message : 'Failed to load your library'))
  }, [])

  useEffect(() => {
    session.client
      .getSeriesCategories()
      .then((list) => {
        setCategories(list)
        setCategoriesAnswered(true)
        setLoadError(null)
      })
      .catch((err) => setLoadError(err instanceof Error ? err.message : 'Failed to load categories'))
  }, [session])

  const sidebarCategories = useMemo(() => {
    if (playlistSelected !== 'all' && playlistSelected !== 'primary') {
      return additional.find((entry) => entry.id === playlistSelected)?.categories ?? categories
    }
    return categories
  }, [playlistSelected, additional, categories])

  useEffect(() => {
    if (selection.type === 'history') return
    const stamp = (list: SeriesItem[], playlistId?: string, label?: string): SeriesItem[] =>
      playlistId ? list.map((item) => ({ ...item, playlistId, playlistLabel: label })) : list
    if (playlistSelected === 'all') {
      void Promise.allSettled([
        session.client.getSeries(selection.type === 'provider' ? selection.id : undefined),
        ...visibleAdditional.map((entry) =>
          new XtreamClient(entry.id).getSeries(selection.type === 'provider' ? selection.id : undefined)
        )
      ]).then((settled) => {
        const collected: SeriesItem[] = []
        settled.forEach((result, index) => {
          if (result.status !== 'fulfilled') return
          if (index === 0) collected.push(...stamp(result.value))
          else {
            const entry = visibleAdditional[index - 1]
            collected.push(...stamp(result.value, entry.id, entry.label))
          }
        })
        setSeriesList(collected)
        setLoadError(null)
      })
      return
    }
    const client = playlistSelected === 'primary' ? session.client : new XtreamClient(playlistSelected)
    client
      .getSeries(selection.type === 'provider' ? selection.id : undefined)
      .then((list) => {
        setSeriesList(playlistSelected === 'primary' ? list : stamp(list, playlistSelected, additional.find((e) => e.id === playlistSelected)?.label))
        setLoadError(null)
      })
      .catch((err) => setLoadError(err instanceof Error ? err.message : 'Failed to load series'))
  }, [session, selection, playlistSelected, visibleAdditional, additional])

  useEffect(() => {
    reportNowPlaying(nowPlaying?.episode?.title ?? null, 'series')
  }, [nowPlaying])
  useEffect(() => () => reportNowPlaying(null), [])

  // A series search hit is an episode id (that is what the provider's catalogue gives us), so it
  // plays directly rather than trying to browse to its season.
  useEffect(() => {
    if (!playRequest || playRequest.kind !== 'series') return
    playEpisode(
      { id: String(playRequest.streamId), episode_num: 0, title: playRequest.name, container_extension: 'mkv', info: {}, season: 0 } as unknown as SeriesEpisode,
      0,
      playRequest.playlistId
    )
    onPlayHandled?.()
  }, [playRequest?.nonce])

  // Composite (playlist, episode id): episode ids are provider-scoped, so the resume lookup and
  // the history dedupe key on both (v0.79.0).
  const resumeFor = useCallback(
    (episodeId: number, playlistId?: string): ResumePosition | undefined =>
      prefs.resume.find(
        (entry) => entry.kind === 'series' && entry.streamId === episodeId && (entry.playlistId || '') === (playlistId ?? '')
      ),
    [prefs.resume]
  )

  const openSeriesRef = playlistRefOf(openSeries ?? {}) ?? ''

  const episodeResumeFor = useCallback(
    (episodeId: number): ResumePosition | undefined => resumeFor(episodeId, openSeriesRef),
    [resumeFor, openSeriesRef]
  )

  const historyEpisodes = useMemo(() => {
    const seen = new Set<string>()
    const rows: Array<{ id: number; playlistId?: string; title: string; containerExtension: string }> = []
    for (const entry of prefs.history) {
      if (entry.kind !== 'series') continue
      const key = `${entry.playlistId || ''}:${entry.streamId}`
      if (seen.has(key)) continue
      seen.add(key)
      rows.push({ id: entry.streamId, playlistId: entry.playlistId || undefined, title: entry.name, containerExtension: 'mkv' })
    }
    return rows
  }, [prefs.history])

  const playEpisode = useCallback(
    (episode: SeriesEpisode, resumeFrom: number, playlistId?: string): void => {
      setStartAt(resumeFrom)
      setNowPlaying({ episode, playlistId })
      void recordHistory({ kind: 'series', streamId: Number(episode.id), playlistId, name: episode.title })
        .then(() => fetchPrefs().then(setPrefs))
        .catch(() => {})
    },
    []
  )

  const handleProgress = useCallback(
    (positionSeconds: number, durationSeconds: number | null): void => {
      if (!nowPlaying) return
      void setResumePosition(
        {
          kind: 'series',
          streamId: Number(nowPlaying.episode.id),
          playlistId: nowPlaying.playlistId,
          name: nowPlaying.episode.title
        },
        positionSeconds,
        durationSeconds
      )
        .then((resume) => setPrefs((current) => ({ ...current, resume })))
        .catch(() => {})
    },
    [nowPlaying]
  )

  // An episode from an additional playlist plays through that playlist's scoped relay (v0.79.0).
  const nowPlayingClient = nowPlaying?.playlistId ? new XtreamClient(nowPlaying.playlistId) : session.client
  const streamUrl = nowPlaying
    ? nowPlayingClient.getStreamUrl('series', Number(nowPlaying.episode.id), nowPlaying.episode.container_extension)
    : null

  const isSeriesFavourite = useCallback(
    (item: Pick<SeriesItem, 'series_id' | 'playlistId'>): boolean => {
      const ref = playlistRefOf(item) ?? ''
      return seriesFavourites.some((f) => f.streamId === item.series_id && (f.playlistId || '') === ref)
    },
    [seriesFavourites]
  )

  return (
    <div className="app-body">
      <nav className="sidebar" style={{ width: sidebarWidth }}>
          <button
            className={selection.type === 'favourites' ? 'category-btn active' : 'category-btn'}
            onClick={() => (setSelection({ type: 'favourites' }), setOpenSeries(null))}
          >
            ★ Favourites{seriesFavourites.length > 0 ? ` (${seriesFavourites.length})` : ''}
          </button>
        <button
          className={selection.type === 'history' ? 'category-btn active' : 'category-btn'}
          onClick={() => {
            setSelection({ type: 'history' })
            setOpenSeries(null)
          }}
        >
          🕘 Continue watching
        </button>
        <button
          className={selection.type === 'all' ? 'category-btn active' : 'category-btn'}
          onClick={() => {
            setSelection({ type: 'all' })
            setOpenSeries(null)
          }}
        >
          All
        </button>
        {sidebarCategories.map((cat) => (
          <button
            key={cat.category_id}
            className={selection.type === 'provider' && selection.id === cat.category_id ? 'category-btn active' : 'category-btn'}
            onClick={() => {
              setSelection({ type: 'provider', id: cat.category_id })
              setOpenSeries(null)
            }}
          >
            {cat.category_name}
          </button>
        ))}
      </nav>
      {/* The handle lives in the content column, not inside <nav>: the sidebar is a scroll
          container, so a handle inside it is clipped by its own overflow and — with a non-overlay
          scrollbar, which is what "there is a bar to scroll up and down" describes — sits
          underneath that scrollbar, which then takes the pointer instead. Reported repeatedly as
          "the category panel cannot be resized" while the EPG's own column handle (not inside a
          scroller) worked. Here nothing can cover it or clip it. */}
      <div className="content">
        <div
          className="resize-handle resize-handle--col resize-handle--sidebar"
          onPointerDown={startSidebarDrag}
          title="Drag to resize the sidebar"
        />

        {streamUrl && nowPlaying && (
          <NativeVideoPlayer
            url={streamUrl}
            titleKey={`series:${nowPlaying.playlistId ?? ''}:${nowPlaying.episode.id}`}
            initialPositionSeconds={startAt}
            onProgress={handleProgress}
          />
        )}
        {nowPlaying && (
          <div className="now-playing-bar">
              Now playing: {nowPlaying.episode.title}
              {nowPlaying.playlistId && (
                <span className="setup-hint" style={{ marginLeft: 6 }}>
                  · {additional.find((e) => e.id === nowPlaying.playlistId)?.label ?? nowPlaying.playlistId}
                </span>
              )}
              {startAt > 0 && <span className="resume-note"> · resumed at {formatClock(startAt)}</span>}
              {openSeries && (
                <span className="now-playing-actions">
                  <button
                    type="button"
                    className={isSeriesFavourite(openSeries) ? 'prefs-action active' : 'prefs-action'}
                    title={isSeriesFavourite(openSeries) ? 'Remove this series from favourites' : 'Add this series to favourites'}
                    onClick={() => {
                      void setFavourite(
                        {
                          kind: 'series',
                          streamId: openSeries.series_id,
                          playlistId: playlistRefOf(openSeries),
                          name: openSeries.name,
                          category: openSeries.category_id,
                          icon: openSeries.cover
                        },
                        !isSeriesFavourite(openSeries)
                      )
                        .then((favourites) => setPrefs((current) => ({ ...current, favourites })))
                        .catch(() => {})
                    }}
                  >
                    {isSeriesFavourite(openSeries) ? '★' : '☆'}
                  </button>
                </span>
              )}
          </div>
        )}
        {loadError && (
          <div className="login-error" style={{ padding: '8px 16px' }}>
            {loadError}
          </div>
        )}
        {!loadError && categoriesAnswered && categories.length === 0 && playlistSelected === 'primary' && (
          <p className="list-hint" style={{ padding: '8px 16px' }}>
            The provider answered with no series categories — an empty catalogue on their side, not a
            load failure. Live TV is unaffected; if this is new, the account's VOD access may have
            changed on the provider.
          </p>
        )}
        {selection.type === 'history' ? (
          <div className="channel-list">
            <div className="list-toolbar">
              <span className="list-toolbar-title">Continue watching</span>
            </div>
            {historyEpisodes.length === 0 && <p className="list-hint">Nothing watched yet.</p>}
            {historyEpisodes.map((row) => {
              const resume = resumeFor(row.id, row.playlistId)
              const episode = {
                id: String(row.id),
                episode_num: 0,
                title: row.title,
                container_extension: row.containerExtension,
                info: {},
                season: 0
              } as unknown as SeriesEpisode
              return (
                <div key={`${row.playlistId ?? ''}:${row.id}`} className="channel-row-wrap">
                  <button className="channel-row" onClick={() => playEpisode(episode, resume?.positionSeconds ?? 0, row.playlistId)}>
                    <span>{row.title}</span>
                    {row.playlistId && (
                      <span className="setup-hint" style={{ marginLeft: 6, fontSize: '0.68rem', opacity: 0.75 }}>
                        {additional.find((e) => e.id === row.playlistId)?.label ?? row.playlistId}
                      </span>
                    )}
                  </button>
                  {resume && (
                    <ResumeControls
                      resume={resume}
                      onResume={() => playEpisode(episode, resume.positionSeconds, row.playlistId)}
                      onStartOver={() => {
                        void clearResumePosition('series', row.id, row.playlistId)
                          .then((resumePositions) => setPrefs((current) => ({ ...current, resume: resumePositions })))
                          .catch(() => {})
                        playEpisode(episode, 0, row.playlistId)
                      }}
                    />
                  )}
                </div>
              )
            })}
          </div>
        ) : openSeries ? (
          <>
            <button className="category-btn" onClick={() => setOpenSeries(null)}>
              ← Back to {openSeries.name ? 'series list' : 'list'}
            </button>
            <EpisodeList
              client={openSeries.playlistId ? new XtreamClient(openSeries.playlistId) : session.client}
              seriesId={openSeries.series_id}
              resumeFor={episodeResumeFor}
              onPlay={(episode, resumeFrom) => playEpisode(episode, resumeFrom, playlistRefOf(openSeries))}
            />
          </>
        ) : (
          <div className="channel-list">
            <div className="list-toolbar">
              <span className="list-toolbar-title">Series</span>
              {visibleAdditional.length > 0 && (
                <span className="view-toggle" role="group" aria-label="Which playlist's series to browse">
                  <button
                    type="button"
                    className={playlistSelected === 'all' ? 'admin-small-btn active' : 'admin-small-btn'}
                    onClick={() => setPlaylistSelected('all')}
                    title="Every visible playlist's series, provenance badged"
                  >
                    All
                  </button>
                  <button
                    type="button"
                    className={playlistSelected === 'primary' ? 'admin-small-btn active' : 'admin-small-btn'}
                    onClick={() => setPlaylistSelected('primary')}
                  >
                    Main
                  </button>
                  {visibleAdditional.map((entry) => (
                    <button
                      key={entry.id}
                      type="button"
                      className={playlistSelected === entry.id ? 'admin-small-btn active' : 'admin-small-btn'}
                      onClick={() => setPlaylistSelected(entry.id)}
                      title={entry.error ?? undefined}
                    >
                      {entry.label}
                      {entry.error ? ' (offline)' : ''}
                    </button>
                  ))}
                </span>
              )}
            </div>
            {(selection.type === 'favourites'
              ? seriesFavourites.map((f) => ({ series_id: f.streamId, name: f.name, playlistId: f.playlistId } as SeriesItem))
              : seriesList
            ).map((item) => (
              <button
                key={`${playlistRefOf(item) ?? ''}:${item.series_id}`}
                className="channel-row"
                onClick={() => setOpenSeries(item)}
              >
                {item.name}
                {item.playlistId && item.playlistId !== 'primary' && (
                  <span className="setup-hint" style={{ marginLeft: 6, fontSize: '0.68rem', opacity: 0.75 }}>
                    {item.playlistLabel ?? additional.find((e) => e.id === item.playlistId)?.label ?? item.playlistId}
                  </span>
                )}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

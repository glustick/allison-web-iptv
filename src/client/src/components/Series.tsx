import { useCallback, useEffect, useMemo, useState, type JSX } from 'react'
import type { Session } from '../lib/appAuth'
import { reportNowPlaying } from '../lib/activityReporter'
import { NativeVideoPlayer } from './NativeVideoPlayer'
import { useSidebarWidth } from '../lib/useSidebarWidth'
import { formatClock } from './Movies'
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

/** Resuming an episode is the whole point of tracking series progress: the position is keyed by
 *  episode id, so each episode in a season keeps its own place. */
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
  session,
  seriesId,
  resumeFor,
  onPlay
}: {
  session: Session
  seriesId: number
  resumeFor: (episodeId: number) => ResumePosition | undefined
  onPlay: (episode: SeriesEpisode, resumeFrom: number) => void
}): JSX.Element {
  const [info, setInfo] = useState<SeriesInfo | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setInfo(null)
    session.client
      .getSeriesInfo(seriesId)
      .then(setInfo)
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load episodes'))
  }, [session, seriesId])

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
  playRequest?: { kind: string; streamId: number; name: string; nonce: number } | null
  onPlayHandled?: () => void
}): JSX.Element {
  const [categories, setCategories] = useState<Category[]>([])
  const [selectedCategoryId, setSelectedCategoryId] = useState<string | null>(null)
  const [seriesList, setSeriesList] = useState<SeriesItem[]>([])
  const [openSeries, setOpenSeries] = useState<SeriesItem | null>(null)
  // Series favourites: prefs already stores them (kind 'series'); this tab just never showed them.
  const [nowPlaying, setNowPlaying] = useState<{ episode: SeriesEpisode } | null>(null)
  const [startAt, setStartAt] = useState(0)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [selection, setSelection] = useState<Selection>({ type: 'all' })
  const [prefs, setPrefs] = useState<PrefsState>(EMPTY_PREFS)
  const seriesFavourites = useMemo(() => prefs.favourites.filter((f) => f.kind === 'series'), [prefs.favourites])
  const { sidebarWidth, startSidebarDrag } = useSidebarWidth()

  useEffect(() => {
    fetchPrefs()
      .then(setPrefs)
      .catch((err) => setLoadError(err instanceof Error ? err.message : 'Failed to load your library'))
  }, [])

  useEffect(() => {
    session.client
      .getSeriesCategories()
      .then(setCategories)
      .catch((err) => setLoadError(err instanceof Error ? err.message : 'Failed to load categories'))
  }, [session])

  useEffect(() => {
    if (selection.type === 'history') return
    session.client
      .getSeries(selection.type === 'provider' ? selection.id : undefined)
      .then(setSeriesList)
      .catch((err) => setLoadError(err instanceof Error ? err.message : 'Failed to load series'))
  }, [session, selection])

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
      0
    )
    onPlayHandled?.()
  }, [playRequest?.nonce])

  const resumeFor = useCallback(
    (episodeId: number): ResumePosition | undefined =>
      prefs.resume.find((entry) => entry.kind === 'series' && entry.streamId === episodeId),
    [prefs.resume]
  )

  const historyEpisodes = useMemo(() => {
    const seen = new Set<number>()
    const rows: Array<{ id: number; title: string; containerExtension: string }> = []
    for (const entry of prefs.history) {
      if (entry.kind !== 'series' || seen.has(entry.streamId)) continue
      seen.add(entry.streamId)
      rows.push({ id: entry.streamId, title: entry.name, containerExtension: 'mkv' })
    }
    return rows
  }, [prefs.history])

  const playEpisode = useCallback(
    (episode: SeriesEpisode, resumeFrom: number): void => {
      setStartAt(resumeFrom)
      setNowPlaying({ episode })
      void recordHistory({ kind: 'series', streamId: Number(episode.id), name: episode.title })
        .then(() => fetchPrefs().then(setPrefs))
        .catch(() => {})
    },
    []
  )

  const handleProgress = useCallback(
    (positionSeconds: number, durationSeconds: number | null): void => {
      if (!nowPlaying) return
      void setResumePosition(
        { kind: 'series', streamId: Number(nowPlaying.episode.id), name: nowPlaying.episode.title },
        positionSeconds,
        durationSeconds
      )
        .then((resume) => setPrefs((current) => ({ ...current, resume })))
        .catch(() => {})
    },
    [nowPlaying]
  )

  const streamUrl = nowPlaying
    ? session.client.getStreamUrl('series', Number(nowPlaying.episode.id), nowPlaying.episode.container_extension)
    : null

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
        {categories.map((cat) => (
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
            titleKey={`series:${nowPlaying.episode.id}`}
            initialPositionSeconds={startAt}
            onProgress={handleProgress}
          />
        )}
        {nowPlaying && (
          <div className="now-playing-bar">
              Now playing: {nowPlaying.episode.title}
              {startAt > 0 && <span className="resume-note"> · resumed at {formatClock(startAt)}</span>}
              {openSeries && (
                <span className="now-playing-actions">
                  <button
                    type="button"
                    className={
                      seriesFavourites.some((f) => f.streamId === openSeries.series_id)
                        ? 'prefs-action active'
                        : 'prefs-action'
                    }
                    title={
                      seriesFavourites.some((f) => f.streamId === openSeries.series_id)
                        ? 'Remove this series from favourites'
                        : 'Add this series to favourites'
                    }
                    onClick={() => {
                      const isFavourite = seriesFavourites.some((f) => f.streamId === openSeries.series_id)
                      void setFavourite(
                        {
                          kind: 'series',
                          streamId: openSeries.series_id,
                          name: openSeries.name,
                          category: openSeries.category_id,
                          icon: openSeries.cover
                        },
                        !isFavourite
                      )
                        .then((favourites) => setPrefs((current) => ({ ...current, favourites })))
                        .catch(() => {})
                    }}
                  >
                    {seriesFavourites.some((f) => f.streamId === openSeries.series_id) ? '★' : '☆'}
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
        {selection.type === 'history' ? (
          <div className="channel-list">
            <div className="list-toolbar">
              <span className="list-toolbar-title">Continue watching</span>
            </div>
            {historyEpisodes.length === 0 && <p className="list-hint">Nothing watched yet.</p>}
            {historyEpisodes.map((row) => {
              const resume = resumeFor(row.id)
              const episode = {
                id: String(row.id),
                episode_num: 0,
                title: row.title,
                container_extension: row.containerExtension,
                info: {},
                season: 0
              } as unknown as SeriesEpisode
              return (
                <div key={row.id} className="channel-row-wrap">
                  <button className="channel-row" onClick={() => playEpisode(episode, resume?.positionSeconds ?? 0)}>
                    <span>{row.title}</span>
                  </button>
                  {resume && (
                    <ResumeControls
                      resume={resume}
                      onResume={() => playEpisode(episode, resume.positionSeconds)}
                      onStartOver={() => {
                        void clearResumePosition('series', row.id)
                          .then((resumePositions) => setPrefs((current) => ({ ...current, resume: resumePositions })))
                          .catch(() => {})
                        playEpisode(episode, 0)
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
            <EpisodeList session={session} seriesId={openSeries.series_id} resumeFor={resumeFor} onPlay={playEpisode} />
          </>
        ) : (
          <div className="channel-list">
              {(selection.type === 'favourites'
                ? seriesFavourites.map((f) => ({ series_id: f.streamId, name: f.name } as SeriesItem))
                : seriesList
              ).map((item) => (
                <button key={item.series_id} className="channel-row" onClick={() => setOpenSeries(item)}>
                  {item.name}
                </button>
              ))}
          </div>
        )}
      </div>
    </div>
  )
}

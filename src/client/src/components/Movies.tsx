import { useCallback, useEffect, useMemo, useState, type JSX } from 'react'
import type { Session } from '../lib/appAuth'
import { reportNowPlaying } from '../lib/activityReporter'
import { NativeVideoPlayer } from './NativeVideoPlayer'
import { useSidebarWidth } from '../lib/useSidebarWidth'
import {
  clearResumePosition,
  fetchPrefs,
  recordHistory,
  setFavourite,
  setResumePosition,
  type PrefsState,
  type ResumePosition
} from '../lib/prefs'
import type { Category, VodStream } from '../lib/types'

const EMPTY_PREFS: PrefsState = { favourites: [], categories: [], history: [], resume: [] }

type Selection = { type: 'all' } | { type: 'provider'; id: string } | { type: 'favourites' } | { type: 'history' }

/** "1:02:03" / "12:34" — resume points read better as a clock than as seconds. */
export function formatClock(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds))
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const rest = seconds % 60
  const pad = (value: number): string => String(value).padStart(2, '0')
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(rest)}` : `${minutes}:${pad(rest)}`
}

export function Movies({
  session,
  playRequest,
  onPlayHandled
}: {
  session: Session
  playRequest?: { kind: string; streamId: number; name: string; nonce: number } | null
  onPlayHandled?: () => void
}): JSX.Element {
  const [categories, setCategories] = useState<Category[]>([])
  // Same landing view as live TV: favourites, which explains itself when empty.
  const [selection, setSelection] = useState<Selection>({ type: 'favourites' })
  const [movies, setMovies] = useState<VodStream[]>([])
  const [nowPlaying, setNowPlaying] = useState<VodStream | null>(null)
  // The position this playback started from, so the player seeks there once and the UI can show
  // whether we resumed or started fresh.
  const [startAt, setStartAt] = useState(0)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [prefs, setPrefs] = useState<PrefsState>(EMPTY_PREFS)
  const { sidebarWidth, startSidebarDrag } = useSidebarWidth()

  const applyPrefs = useCallback((next: PrefsState): void => setPrefs(next), [])

  useEffect(() => {
    session.client
      .getVodCategories()
      .then(setCategories)
      .catch((err) => setLoadError(err instanceof Error ? err.message : 'Failed to load categories'))
  }, [session])

  useEffect(() => {
    fetchPrefs()
      .then(applyPrefs)
      .catch((err) => setLoadError(err instanceof Error ? err.message : 'Failed to load your library'))
  }, [applyPrefs])

  useEffect(() => {
    if (selection.type !== 'all' && selection.type !== 'provider') return
    session.client
      .getVodStreams(selection.type === 'provider' ? selection.id : undefined)
      .then(setMovies)
      .catch((err) => setLoadError(err instanceof Error ? err.message : 'Failed to load movies'))
  }, [session, selection])

  useEffect(() => {
    reportNowPlaying(nowPlaying?.name ?? null, 'movie')
  }, [nowPlaying])
  useEffect(() => () => reportNowPlaying(null), [])

  useEffect(() => {
    if (!playRequest || playRequest.kind !== 'movie') return
    play(playRequest.streamId, playRequest.name, 0)
    onPlayHandled?.()
  }, [playRequest?.nonce])

  const movieResume = useMemo(() => {
    const map = new Map<number, ResumePosition>()
    for (const entry of prefs.resume) if (entry.kind === 'movie') map.set(entry.streamId, entry)
    return map
  }, [prefs.resume])

  const movieFavourites = useMemo(() => prefs.favourites.filter((f) => f.kind === 'movie'), [prefs.favourites])

  const historyMovies = useMemo(() => {
    const seen = new Set<number>()
    const rows: Array<{ streamId: number; name: string }> = []
    for (const entry of prefs.history) {
      if (entry.kind !== 'movie' || seen.has(entry.streamId)) continue
      seen.add(entry.streamId)
      rows.push({ streamId: entry.streamId, name: entry.name })
    }
    return rows
  }, [prefs.history])

  const play = useCallback(
    (streamId: number, name: string, resumeFrom: number): void => {
      // A library row has no VodStream of its own — the player only needs id, name and container
      // extension, and 'mkv' is the safe default the provider accepts for on-demand streams.
      const stream: VodStream = (movies.find((movie) => movie.stream_id === streamId) ?? {
        num: 0,
        name,
        stream_type: 'movie',
        stream_id: streamId,
        stream_icon: '',
        rating: '',
        rating_5based: 0,
        added: '',
        category_id: '',
        container_extension: 'mkv',
        direct_source: ''
      }) as VodStream
      setStartAt(resumeFrom)
      setNowPlaying(stream)
      void recordHistory({ kind: 'movie', streamId, name, category: stream.category_id })
        .then(() => fetchPrefs().then(applyPrefs))
        .catch(() => {})
    },
    [applyPrefs, movies]
  )

  const handleProgress = useCallback(
    (positionSeconds: number, durationSeconds: number | null): void => {
      if (!nowPlaying) return
      void setResumePosition(
        { kind: 'movie', streamId: nowPlaying.stream_id, name: nowPlaying.name, category: nowPlaying.category_id },
        positionSeconds,
        durationSeconds
      )
        .then((resume) => setPrefs((current) => ({ ...current, resume })))
        .catch(() => {})
    },
    [nowPlaying]
  )

  const streamUrl = nowPlaying ? session.client.getStreamUrl('movie', nowPlaying.stream_id, nowPlaying.container_extension) : null
  const listRows: Array<{ streamId: number; name: string }> =
    selection.type === 'favourites'
      ? movieFavourites.map((favourite) => ({ streamId: favourite.streamId, name: favourite.name }))
      : selection.type === 'history'
        ? historyMovies
        : movies.map((movie) => ({ streamId: movie.stream_id, name: movie.name }))
  const sectionTitle = selection.type === 'favourites' ? 'Favourite films' : selection.type === 'history' ? 'Watch history' : 'All films'

  return (
    <div className="app-body">
      <nav className="sidebar" style={{ width: sidebarWidth }}>
        <button className={selection.type === 'favourites' ? 'category-btn active' : 'category-btn'} onClick={() => setSelection({ type: 'favourites' })}>
          ★ Favourites{movieFavourites.length > 0 ? ` (${movieFavourites.length})` : ''}
        </button>
        <button className={selection.type === 'history' ? 'category-btn active' : 'category-btn'} onClick={() => setSelection({ type: 'history' })}>
          🕘 History
        </button>
        <button className={selection.type === 'all' ? 'category-btn active' : 'category-btn'} onClick={() => setSelection({ type: 'all' })}>
          All
        </button>
        {categories.map((cat) => (
          <button
            key={cat.category_id}
            className={selection.type === 'provider' && selection.id === cat.category_id ? 'category-btn active' : 'category-btn'}
            onClick={() => setSelection({ type: 'provider', id: cat.category_id })}
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
          <div className="player-section">
            <NativeVideoPlayer
              url={streamUrl}
              titleKey={`movie:${nowPlaying.stream_id}`}
              initialPositionSeconds={startAt}
              onProgress={handleProgress}
            />
            <div className="now-playing-bar">
              <span>
                Now playing: {nowPlaying.name}
                {startAt > 0 && <span className="resume-note"> · resumed at {formatClock(startAt)}</span>}
              </span>
              <span className="now-playing-actions">
                <button
                  type="button"
                  className={movieFavourites.some((favourite) => favourite.streamId === nowPlaying.stream_id) ? 'prefs-action active' : 'prefs-action'}
                  title="Add to favourites"
                  onClick={() => {
                    const isFavourite = movieFavourites.some((favourite) => favourite.streamId === nowPlaying.stream_id)
                    void setFavourite(
                      {
                        kind: 'movie',
                        streamId: nowPlaying.stream_id,
                        name: nowPlaying.name,
                        category: nowPlaying.category_id,
                        icon: nowPlaying.stream_icon
                      },
                      !isFavourite
                    )
                      .then((favourites) => setPrefs((current) => ({ ...current, favourites })))
                      .catch(() => {})
                  }}
                >
                  {movieFavourites.some((favourite) => favourite.streamId === nowPlaying.stream_id) ? '★' : '☆'}
                </button>
              </span>
            </div>
          </div>
        )}
        {loadError && (
          <div className="login-error" style={{ padding: '8px 16px' }}>
            {loadError}
          </div>
        )}
        <div className="list-toolbar">
          <span className="list-toolbar-title">{sectionTitle}</span>
        </div>
        <div className="channel-list">
          {listRows.length === 0 && (
            <p className="list-hint">
              {selection.type === 'favourites' ? 'No favourite films yet — press ☆ while one plays.' : selection.type === 'history' ? 'Nothing watched yet.' : 'No films to show.'}
            </p>
          )}
          {listRows.map((row) => {
            const resume = movieResume.get(row.streamId)
            const percent = resume?.durationSeconds ? Math.min(100, Math.round((resume.positionSeconds / resume.durationSeconds) * 100)) : null
            return (
              <div key={row.streamId} className="channel-row-wrap">
                <button
                  className={nowPlaying?.stream_id === row.streamId ? 'channel-row active' : 'channel-row'}
                  onClick={() => play(row.streamId, row.name, resume?.positionSeconds ?? 0)}
                >
                  <span>{row.name}</span>
                  {resume && (
                    <span className="resume-badge">
                      {percent !== null ? `${percent}% · ` : ''}
                      {formatClock(resume.positionSeconds)}
                    </span>
                  )}
                </button>
                {resume && (
                  <>
                    <button
                      type="button"
                      className="admin-small-btn"
                      title="Continue where you left off"
                      onClick={() => play(row.streamId, row.name, resume.positionSeconds)}
                    >
                      Resume
                    </button>
                    <button
                      type="button"
                      className="admin-small-btn"
                      title="Start this title from the beginning and forget the resume point"
                      onClick={() => {
                        void clearResumePosition('movie', row.streamId)
                          .then((resumePositions) => setPrefs((current) => ({ ...current, resume: resumePositions })))
                          .catch(() => {})
                        play(row.streamId, row.name, 0)
                      }}
                    >
                      Start over
                    </button>
                  </>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

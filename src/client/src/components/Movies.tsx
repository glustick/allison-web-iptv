import { useCallback, useEffect, useMemo, useState, type JSX } from 'react'
import type { Session } from '../lib/appAuth'
import { reportNowPlaying } from '../lib/activityReporter'
import { NativeVideoPlayer } from './NativeVideoPlayer'
import { useSidebarWidth } from '../lib/useSidebarWidth'
import { XtreamClient } from '../lib/xtreamClient'
import { playlistRefOf } from '../lib/types'
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
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(rest)}` : `${pad(minutes)}:${pad(rest)}`
}

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

export function Movies({
  session,
  playRequest,
  onPlayHandled
}: {
  session: Session
  playRequest?: { kind: string; streamId: number; name: string; playlistId?: string; nonce: number } | null
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
  // True once the category fetch has *answered* — an empty catalogue that arrived as an answer is
  // the provider's to explain, and it deserves a sentence rather than a silently bare sidebar.
  const [categoriesAnswered, setCategoriesAnswered] = useState(false)
  const [prefs, setPrefs] = useState<PrefsState>(EMPTY_PREFS)
  const { sidebarWidth, startSidebarDrag } = useSidebarWidth()

  // --- additional playlists (v0.79.0) -------------------------------------------------------
  // The LiveTv pattern: fetch every additional playlist's VOD categories once, in parallel, with
  // independent failures — one dead provider leaves its chip saying "(offline)" and everything
  // else working. Streams load per selection through each playlist's scoped client.
  const [additional, setAdditional] = useState<AdditionalVod[]>([])
  const [hidden, setHidden] = useState<string[]>(readHiddenPlaylists)
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
              const list = await new XtreamClient(p.id).getVodCategories()
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

  // Which playlist the browsing selection points at: 'primary' (the default), one additional
  // playlist's id, or 'all' (merged, the LiveTv convention).
  const [playlistSelected, setPlaylistSelected] = useState<string>('primary')

  const applyPrefs = useCallback((next: PrefsState): void => setPrefs(next), [])

  useEffect(() => {
    session.client
      .getVodCategories()
      .then((list) => {
        setCategories(list)
        setCategoriesAnswered(true)
        setLoadError(null)
      })
      .catch((err) => setLoadError(err instanceof Error ? err.message : 'Failed to load categories'))
  }, [session])

  useEffect(() => {
    fetchPrefs()
      .then(applyPrefs)
      .catch((err) => setLoadError(err instanceof Error ? err.message : 'Failed to load your library'))
  }, [applyPrefs])

  // The categories the sidebar offers follow the selected playlist; "all" browses the primary's
  // categories (the merge is in the film list, exactly how LiveTv's grid works).
  const sidebarCategories = useMemo(() => {
    if (playlistSelected !== 'all' && playlistSelected !== 'primary') {
      return additional.find((entry) => entry.id === playlistSelected)?.categories ?? categories
    }
    return categories
  }, [playlistSelected, additional, categories])

  useEffect(() => {
    if (selection.type !== 'all' && selection.type !== 'provider') return
    const stamp = (list: VodStream[], playlistId?: string, label?: string): VodStream[] =>
      playlistId ? list.map((movie) => ({ ...movie, playlistId, playlistLabel: label })) : list
    if (playlistSelected === 'all') {
      // Independent failures again: a playlist whose films cannot load says so in its chip, and
      // the merged list keeps everyone else's.
      void Promise.allSettled([
        session.client.getVodStreams(selection.type === 'provider' ? selection.id : undefined),
        ...visibleAdditional.map((entry) =>
          new XtreamClient(entry.id).getVodStreams(selection.type === 'provider' ? selection.id : undefined)
        )
      ]).then((settled) => {
        const collected: VodStream[] = []
        settled.forEach((result, index) => {
          if (result.status !== 'fulfilled') return
          if (index === 0) collected.push(...stamp(result.value))
          else {
            const entry = visibleAdditional[index - 1]
            collected.push(...stamp(result.value, entry.id, entry.label))
          }
        })
        setMovies(collected)
        setLoadError(null)
      })
      return
    }
    const client = playlistSelected === 'primary' ? session.client : new XtreamClient(playlistSelected)
    client
      .getVodStreams(selection.type === 'provider' ? selection.id : undefined)
      .then((list) => {
        setMovies(playlistSelected === 'primary' ? list : stamp(list, playlistSelected, additional.find((e) => e.id === playlistSelected)?.label))
        setLoadError(null)
      })
      .catch((err) => setLoadError(err instanceof Error ? err.message : 'Failed to load movies'))
  }, [session, selection, playlistSelected, visibleAdditional, additional])

  useEffect(() => {
    reportNowPlaying(nowPlaying?.name ?? null, 'movie')
  }, [nowPlaying])
  useEffect(() => () => reportNowPlaying(null), [])

  useEffect(() => {
    if (!playRequest || playRequest.kind !== 'movie') return
    play(playRequest.streamId, playRequest.name, 0, playRequest.playlistId)
    onPlayHandled?.()
  }, [playRequest?.nonce])

  // Composite keys throughout (v0.79.0): film ids are provider-scoped, so the resume map, the
  // history dedupe and the favourites match all carry the playlist ref.
  const movieResume = useMemo(() => {
    const map = new Map<string, ResumePosition>()
    for (const entry of prefs.resume) {
      if (entry.kind === 'movie') map.set(`${entry.playlistId || ''}:${entry.streamId}`, entry)
    }
    return map
  }, [prefs.resume])

  const movieFavourites = useMemo(() => prefs.favourites.filter((f) => f.kind === 'movie'), [prefs.favourites])

  const isFavourite = useCallback(
    (movie: Pick<VodStream, 'stream_id' | 'playlistId'>): boolean => {
      const ref = playlistRefOf(movie) ?? ''
      return movieFavourites.some((favourite) => favourite.streamId === movie.stream_id && (favourite.playlistId || '') === ref)
    },
    [movieFavourites]
  )

  const historyMovies = useMemo(() => {
    const seen = new Set<string>()
    const rows: Array<{ streamId: number; playlistId?: string; name: string }> = []
    for (const entry of prefs.history) {
      if (entry.kind !== 'movie') continue
      const key = `${entry.playlistId || ''}:${entry.streamId}`
      if (seen.has(key)) continue
      seen.add(key)
      rows.push({ streamId: entry.streamId, playlistId: entry.playlistId || undefined, name: entry.name })
    }
    return rows
  }, [prefs.history])

  const play = useCallback(
    (streamId: number, name: string, resumeFrom: number, playlistId?: string): void => {
      // A library row has no VodStream of its own — the player only needs id, name and container
      // extension, and 'mkv' is the safe default the provider accepts for on-demand streams.
      const stream: VodStream = (movies.find(
        (movie) => movie.stream_id === streamId && (playlistRefOf(movie) ?? '') === (playlistId ?? '')
      ) ?? {
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
        direct_source: '',
        ...(playlistId ? { playlistId, playlistLabel: additional.find((e) => e.id === playlistId)?.label } : {})
      }) as VodStream
      setStartAt(resumeFrom)
      setNowPlaying(stream)
      void recordHistory({
        kind: 'movie',
        streamId,
        playlistId,
        name,
        category: stream.category_id
      })
        .then(() => fetchPrefs().then(applyPrefs))
        .catch(() => {})
    },
    [applyPrefs, movies, additional]
  )

  const handleProgress = useCallback(
    (positionSeconds: number, durationSeconds: number | null): void => {
      if (!nowPlaying) return
      void setResumePosition(
        {
          kind: 'movie',
          streamId: nowPlaying.stream_id,
          playlistId: playlistRefOf(nowPlaying),
          name: nowPlaying.name,
          category: nowPlaying.category_id
        },
        positionSeconds,
        durationSeconds
      )
        .then((resume) => setPrefs((current) => ({ ...current, resume })))
        .catch(() => {})
    },
    [nowPlaying]
  )

  // A film from an additional playlist plays through that playlist's scoped relay — the server
  // resolves its credentials, and the browser never sees the second provider at all.
  const nowPlayingClient = nowPlaying?.playlistId && nowPlaying.playlistId !== 'primary'
    ? new XtreamClient(nowPlaying.playlistId)
    : session.client
  const streamUrl = nowPlaying ? nowPlayingClient.getStreamUrl('movie', nowPlaying.stream_id, nowPlaying.container_extension) : null
  const listRows: Array<{ streamId: number; playlistId?: string; name: string }> =
    selection.type === 'favourites'
      ? movieFavourites.map((favourite) => ({ streamId: favourite.streamId, playlistId: favourite.playlistId || undefined, name: favourite.name }))
      : selection.type === 'history'
        ? historyMovies
        : movies.map((movie) => ({ streamId: movie.stream_id, playlistId: playlistRefOf(movie), name: movie.name }))
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
        {sidebarCategories.map((cat) => (
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
              titleKey={`movie:${playlistRefOf(nowPlaying) ?? ''}:${nowPlaying.stream_id}`}
              initialPositionSeconds={startAt}
              onProgress={handleProgress}
            />
            <div className="now-playing-bar">
              <span>
                Now playing: {nowPlaying.name}
                {nowPlaying.playlistId && nowPlaying.playlistId !== 'primary' && nowPlaying.playlistLabel && (
                  <span className="setup-hint" style={{ marginLeft: 6 }}> · {nowPlaying.playlistLabel}</span>
                )}
                {startAt > 0 && <span className="resume-note"> · resumed at {formatClock(startAt)}</span>}
              </span>
              <span className="now-playing-actions">
                <button
                  type="button"
                  className={isFavourite(nowPlaying) ? 'prefs-action active' : 'prefs-action'}
                  title={isFavourite(nowPlaying) ? 'Remove from favourites' : 'Add to favourites'}
                  onClick={() => {
                    void setFavourite(
                      {
                        kind: 'movie',
                        streamId: nowPlaying.stream_id,
                        playlistId: playlistRefOf(nowPlaying),
                        name: nowPlaying.name,
                        category: nowPlaying.category_id,
                        icon: nowPlaying.stream_icon
                      },
                      !isFavourite(nowPlaying)
                    )
                      .then((favourites) => setPrefs((current) => ({ ...current, favourites })))
                      .catch(() => {})
                  }}
                >
                  {isFavourite(nowPlaying) ? '★' : '☆'}
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
        {!loadError && categoriesAnswered && categories.length === 0 && playlistSelected === 'primary' && (
          <p className="list-hint" style={{ padding: '8px 16px' }}>
            The provider answered with no movie categories — an empty VOD catalogue on their side, not
            a load failure. Live TV is unaffected; if this is new, the account's VOD access may have
            changed on the provider.
          </p>
        )}
        <div className="list-toolbar">
          <span className="list-toolbar-title">{sectionTitle}</span>
          {visibleAdditional.length > 0 && (
            <span className="view-toggle" role="group" aria-label="Which playlist's films to browse">
              <button
                type="button"
                className={playlistSelected === 'all' ? 'admin-small-btn active' : 'admin-small-btn'}
                onClick={() => setPlaylistSelected('all')}
                title="Every visible playlist's films, provenance badged"
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
        <div className="channel-list">
          {listRows.length === 0 && (
            <p className="list-hint">
              {selection.type === 'favourites' ? 'No favourite films yet — press ☆ while one plays.' : selection.type === 'history' ? 'Nothing watched yet.' : 'No films to show.'}
            </p>
          )}
          {listRows.map((row) => {
            const resume = movieResume.get(`${row.playlistId ?? ''}:${row.streamId}`)
            const percent = resume?.durationSeconds ? Math.min(100, Math.round((resume.positionSeconds / resume.durationSeconds) * 100)) : null
            return (
              <div key={`${row.playlistId ?? ''}:${row.streamId}`} className="channel-row-wrap">
                <button
                  className={
                    nowPlaying?.stream_id === row.streamId && (playlistRefOf(nowPlaying) ?? '') === (row.playlistId ?? '')
                      ? 'channel-row active'
                      : 'channel-row'
                  }
                  onClick={() => play(row.streamId, row.name, resume?.positionSeconds ?? 0, row.playlistId)}
                >
                  <span>{row.name}</span>
                  {row.playlistId && row.playlistId !== 'primary' && (
                    <span className="setup-hint" style={{ marginLeft: 6, fontSize: '0.68rem', opacity: 0.75 }}>
                      {additional.find((e) => e.id === row.playlistId)?.label ?? row.playlistId}
                    </span>
                  )}
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
                      onClick={() => play(row.streamId, row.name, resume.positionSeconds, row.playlistId)}
                    >
                      Resume
                    </button>
                    <button
                      type="button"
                      className="admin-small-btn"
                      title="Start this title from the beginning and forget the resume point"
                      onClick={() => {
                        void clearResumePosition('movie', row.streamId, row.playlistId)
                          .then((resumePositions) => setPrefs((current) => ({ ...current, resume: resumePositions })))
                          .catch(() => {})
                        play(row.streamId, row.name, 0, row.playlistId)
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

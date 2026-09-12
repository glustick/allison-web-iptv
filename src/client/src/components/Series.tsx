import { useEffect, useState, type JSX } from 'react'
import type { Session } from './LoginScreen'
import { NativeVideoPlayer } from './NativeVideoPlayer'
import { useSidebarWidth } from '../lib/useSidebarWidth'
import type { Category, SeriesItem, SeriesInfo, SeriesEpisode } from '../lib/types'

function EpisodeList({
  session,
  seriesId,
  onPlay
}: {
  session: Session
  seriesId: number
  onPlay: (episode: SeriesEpisode) => void
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
          {(info.episodes[String(seasonNumber)] ?? []).map((episode) => (
            <button key={episode.id} className="channel-row" onClick={() => onPlay(episode)}>
              {episode.episode_num}. {episode.title}
            </button>
          ))}
        </div>
      ))}
    </div>
  )
}

export function Series({ session }: { session: Session }): JSX.Element {
  const [categories, setCategories] = useState<Category[]>([])
  const [selectedCategoryId, setSelectedCategoryId] = useState<string | null>(null)
  const [seriesList, setSeriesList] = useState<SeriesItem[]>([])
  const [openSeries, setOpenSeries] = useState<SeriesItem | null>(null)
  const [nowPlaying, setNowPlaying] = useState<{ episode: SeriesEpisode } | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const { sidebarWidth, startSidebarDrag } = useSidebarWidth()

  useEffect(() => {
    session.client
      .getSeriesCategories()
      .then(setCategories)
      .catch((err) => setLoadError(err instanceof Error ? err.message : 'Failed to load categories'))
  }, [session])

  useEffect(() => {
    session.client
      .getSeries(selectedCategoryId ?? undefined)
      .then(setSeriesList)
      .catch((err) => setLoadError(err instanceof Error ? err.message : 'Failed to load series'))
  }, [session, selectedCategoryId])

  const streamUrl = nowPlaying
    ? session.client.getStreamUrl('series', Number(nowPlaying.episode.id), nowPlaying.episode.container_extension)
    : null

  return (
    <div className="app-body">
      <nav className="sidebar" style={{ width: sidebarWidth }}>
        <button
          className={selectedCategoryId === null ? 'category-btn active' : 'category-btn'}
          onClick={() => {
            setSelectedCategoryId(null)
            setOpenSeries(null)
          }}
        >
          All
        </button>
        {categories.map((cat) => (
          <button
            key={cat.category_id}
            className={selectedCategoryId === cat.category_id ? 'category-btn active' : 'category-btn'}
            onClick={() => {
              setSelectedCategoryId(cat.category_id)
              setOpenSeries(null)
            }}
          >
            {cat.category_name}
          </button>
        ))}
        <div
          className="resize-handle resize-handle--col resize-handle--sidebar"
          onPointerDown={startSidebarDrag}
          title="Drag to resize the sidebar"
        />
      </nav>
      <div className="content">
        {streamUrl && nowPlaying && (
          <NativeVideoPlayer url={streamUrl} titleKey={`series:${nowPlaying.episode.id}`} />
        )}
        {nowPlaying && <div className="now-playing-bar">Now playing: {nowPlaying.episode.title}</div>}
        {loadError && (
          <div className="login-error" style={{ padding: '8px 16px' }}>
            {loadError}
          </div>
        )}
        {openSeries ? (
          <>
            <button className="category-btn" onClick={() => setOpenSeries(null)}>
              ← Back to {openSeries.name ? 'series list' : 'list'}
            </button>
            <EpisodeList session={session} seriesId={openSeries.series_id} onPlay={(episode) => setNowPlaying({ episode })} />
          </>
        ) : (
          <div className="channel-list">
            {seriesList.map((item) => (
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

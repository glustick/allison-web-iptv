import { useEffect, useState, type JSX } from 'react'
import type { Session } from './LoginScreen'
import { NativeVideoPlayer } from './NativeVideoPlayer'
import type { Category, VodStream } from '../lib/types'

export function Movies({ session }: { session: Session }): JSX.Element {
  const [categories, setCategories] = useState<Category[]>([])
  const [selectedCategoryId, setSelectedCategoryId] = useState<string | null>(null)
  const [movies, setMovies] = useState<VodStream[]>([])
  const [nowPlaying, setNowPlaying] = useState<VodStream | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  useEffect(() => {
    session.client
      .getVodCategories()
      .then(setCategories)
      .catch((err) => setLoadError(err instanceof Error ? err.message : 'Failed to load categories'))
  }, [session])

  useEffect(() => {
    session.client
      .getVodStreams(selectedCategoryId ?? undefined)
      .then(setMovies)
      .catch((err) => setLoadError(err instanceof Error ? err.message : 'Failed to load movies'))
  }, [session, selectedCategoryId])

  const streamUrl = nowPlaying ? session.client.getStreamUrl('movie', nowPlaying.stream_id, nowPlaying.container_extension) : null

  return (
    <div className="app-body">
      <nav className="sidebar">
        <button className={selectedCategoryId === null ? 'category-btn active' : 'category-btn'} onClick={() => setSelectedCategoryId(null)}>
          All
        </button>
        {categories.map((cat) => (
          <button
            key={cat.category_id}
            className={selectedCategoryId === cat.category_id ? 'category-btn active' : 'category-btn'}
            onClick={() => setSelectedCategoryId(cat.category_id)}
          >
            {cat.category_name}
          </button>
        ))}
      </nav>
      <div className="content">
        {streamUrl && nowPlaying && <NativeVideoPlayer url={streamUrl} titleKey={`movie:${nowPlaying.stream_id}`} />}
        {nowPlaying && <div className="now-playing-bar">Now playing: {nowPlaying.name}</div>}
        {loadError && (
          <div className="login-error" style={{ padding: '8px 16px' }}>
            {loadError}
          </div>
        )}
        <div className="channel-list">
          {movies.map((movie) => (
            <button
              key={movie.stream_id}
              className={nowPlaying?.stream_id === movie.stream_id ? 'channel-row active' : 'channel-row'}
              onClick={() => setNowPlaying(movie)}
            >
              {movie.name}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

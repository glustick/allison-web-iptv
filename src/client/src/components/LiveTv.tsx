import { useEffect, useState, type JSX } from 'react'
import type { Session } from './LoginScreen'
import { LivePlayer } from './LivePlayer'
import { EpgGrid } from './EpgGrid'
import type { Category, LiveStream } from '../lib/types'

export function LiveTv({ session }: { session: Session }): JSX.Element {
  const [categories, setCategories] = useState<Category[]>([])
  const [selectedCategoryId, setSelectedCategoryId] = useState<string | null>(null)
  const [channels, setChannels] = useState<LiveStream[]>([])
  const [nowPlaying, setNowPlaying] = useState<LiveStream | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  useEffect(() => {
    session.client
      .getLiveCategories()
      .then(setCategories)
      .catch((err) => setLoadError(err instanceof Error ? err.message : 'Failed to load categories'))
  }, [session])

  useEffect(() => {
    session.client
      .getLiveStreams(selectedCategoryId ?? undefined)
      .then(setChannels)
      .catch((err) => setLoadError(err instanceof Error ? err.message : 'Failed to load channels'))
  }, [session, selectedCategoryId])

  const streamUrl = nowPlaying ? session.client.getStreamUrl('live', nowPlaying.stream_id, 'm3u8') : null

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
        {streamUrl && nowPlaying && <LivePlayer url={streamUrl} channelKey={`live:${nowPlaying.stream_id}`} />}
        {nowPlaying && <div className="now-playing-bar">Now playing: {nowPlaying.name}</div>}
        {loadError && (
          <div className="login-error" style={{ padding: '8px 16px' }}>
            {loadError}
          </div>
        )}
        <EpgGrid session={session} channels={channels} activeStreamId={nowPlaying?.stream_id} onSelectChannel={setNowPlaying} />
      </div>
    </div>
  )
}

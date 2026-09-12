import { useEffect, useState, type CSSProperties, type JSX } from 'react'
import type { Session } from './LoginScreen'
import { LivePlayer } from './LivePlayer'
import { EpgGrid } from './EpgGrid'
import { useSidebarWidth } from '../lib/useSidebarWidth'
import { loadSavedDimension, saveDimension, useResizableDimension } from '../lib/useResizableDimension'
import type { Category, LiveStream } from '../lib/types'

// The player's height cap is drag-resizable (see useResizableDimension.ts) via the row-resize
// handle on the seam between the player block and the EPG grid below. Defaults reproduce the
// old fixed behavior (video capped at 45vh); the max leaves room to keep the guide visible.
const PLAYER_MAX_HEIGHT_KEY = 'player-max-height'
const PLAYER_MIN_HEIGHT = 120
const PLAYER_DEFAULT_MAX_HEIGHT = (): number => Math.round(window.innerHeight * 0.45)
const PLAYER_MAX_HEIGHT_CEILING = (): number => Math.round(window.innerHeight * 0.8)

export function LiveTv({ session }: { session: Session }): JSX.Element {
  const [categories, setCategories] = useState<Category[]>([])
  const [selectedCategoryId, setSelectedCategoryId] = useState<string | null>(null)
  const [channels, setChannels] = useState<LiveStream[]>([])
  const [nowPlaying, setNowPlaying] = useState<LiveStream | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
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
      <nav className="sidebar" style={{ width: sidebarWidth }}>
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
        <div
          className="resize-handle resize-handle--col resize-handle--sidebar"
          onPointerDown={startSidebarDrag}
          title="Drag to resize the sidebar"
        />
      </nav>
      <div className="content">
        {streamUrl && nowPlaying && (
          <div className="player-section" style={{ '--player-max-height': `${playerMaxHeight}px` } as CSSProperties}>
            <LivePlayer url={streamUrl} channelKey={`live:${nowPlaying.stream_id}`} />
            <div className="now-playing-bar">Now playing: {nowPlaying.name}</div>
            <div
              className="resize-handle resize-handle--row"
              onPointerDown={startPlayerHeightDrag}
              title="Drag to resize the player"
            />
          </div>
        )}
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

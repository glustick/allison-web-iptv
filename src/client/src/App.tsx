import { useEffect, useRef, useState, type JSX } from 'react'
import Hls from 'hls.js'
import { XtreamClient } from './lib/xtreamClient'
import type { Category, LiveStream } from './lib/types'

interface Session {
  client: XtreamClient
  username: string
  server: string
}

const LAST_LOGIN_KEY = 'allison-web-iptv:last-login'

function loadLastLogin(): { server: string; username: string } {
  try {
    const raw = localStorage.getItem(LAST_LOGIN_KEY)
    if (!raw) return { server: '', username: '' }
    return JSON.parse(raw) as { server: string; username: string }
  } catch {
    return { server: '', username: '' }
  }
}

function LoginScreen({ onConnected }: { onConnected: (session: Session) => void }): JSX.Element {
  const last = loadLastLogin()
  const [accessPassword, setAccessPassword] = useState('')
  const [server, setServer] = useState(last.server)
  const [username, setUsername] = useState(last.username)
  const [password, setPassword] = useState('')
  const [connecting, setConnecting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault()
    setConnecting(true)
    setError(null)
    try {
      const loginRes = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: accessPassword })
      })
      if (!loginRes.ok) {
        const body = (await loginRes.json().catch(() => ({}))) as { error?: string }
        throw new Error(body.error ?? 'Login failed')
      }

      const connectRes = await fetch('/api/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ server })
      })
      if (!connectRes.ok) throw new Error('Could not point the server at that Xtream host')

      const client = new XtreamClient(username, password)
      const auth = await client.authenticate()
      if (auth.user_info.auth !== 1) throw new Error('Invalid Xtream credentials')

      localStorage.setItem(LAST_LOGIN_KEY, JSON.stringify({ server, username }))
      onConnected({ client, username, server })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Connection failed')
    } finally {
      setConnecting(false)
    }
  }

  return (
    <div className="login-screen">
      <form className="login-card" onSubmit={(e) => void handleSubmit(e)}>
        <h1>Allison Web IPTV</h1>
        {error && <div className="login-error">{error}</div>}
        <label>
          Access password
          <input type="password" value={accessPassword} onChange={(e) => setAccessPassword(e.target.value)} required />
        </label>
        <label>
          Xtream server URL
          <input value={server} onChange={(e) => setServer(e.target.value)} placeholder="https://example.com:8080" required />
        </label>
        <label>
          Username
          <input value={username} onChange={(e) => setUsername(e.target.value)} required />
        </label>
        <label>
          Password
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </label>
        <button type="submit" disabled={connecting}>
          {connecting ? 'Connecting…' : 'Connect'}
        </button>
      </form>
    </div>
  )
}

function VideoPlayer({ url }: { url: string | null }): JSX.Element {
  const videoRef = useRef<HTMLVideoElement | null>(null)

  useEffect(() => {
    const video = videoRef.current
    if (!video || !url) return
    let hls: Hls | null = null
    if (Hls.isSupported()) {
      hls = new Hls()
      hls.loadSource(url)
      hls.attachMedia(video)
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (data.fatal) console.error('[player] fatal hls error', data.type, data.details)
      })
    } else {
      video.src = url
    }
    video.play().catch(() => {})
    return () => {
      hls?.destroy()
      video.removeAttribute('src')
      video.load()
    }
  }, [url])

  return (
    <div className="player-wrap">
      <video ref={videoRef} controls muted={false} />
    </div>
  )
}

function LiveTv({ session }: { session: Session }): JSX.Element {
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
        <VideoPlayer url={streamUrl} />
        {nowPlaying && <div className="now-playing-bar">Now playing: {nowPlaying.name}</div>}
        {loadError && <div className="login-error" style={{ padding: '8px 16px' }}>{loadError}</div>}
        <div className="channel-list">
          {channels.map((channel) => (
            <button
              key={channel.stream_id}
              className={nowPlaying?.stream_id === channel.stream_id ? 'channel-row active' : 'channel-row'}
              onClick={() => setNowPlaying(channel)}
            >
              {channel.name}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

export default function App(): JSX.Element {
  const [session, setSession] = useState<Session | null>(null)

  if (!session) return <LoginScreen onConnected={setSession} />

  return (
    <div className="app-shell">
      <div className="top-bar">
        <strong>Allison Web IPTV</strong>
        <span>{session.username}</span>
      </div>
      <LiveTv session={session} />
    </div>
  )
}

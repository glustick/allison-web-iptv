import { useEffect, useState, type JSX } from 'react'
import { LoginScreen, type Session } from './components/LoginScreen'
import { LiveTv } from './components/LiveTv'
import { Movies } from './components/Movies'
import { Series } from './components/Series'

type Tab = 'live' | 'movies' | 'series'

export default function App(): JSX.Element {
  const [session, setSession] = useState<Session | null>(null)
  const [tab, setTab] = useState<Tab>('live')
  const [updateMessage, setUpdateMessage] = useState<string | null>(null)

  useEffect(() => {
    void fetch('/api/version-check')
      .then((res) => res.json())
      .then((data) => {
        if (data.updateAvailable) {
          setUpdateMessage(`Update available: ${data.currentVersion} → ${data.latestVersion}`)
        }
      })
      .catch(() => {})
  }, [])

  if (!session) return <LoginScreen onConnected={setSession} />

  return (
    <div className="app-shell">
      <div className="top-bar">
        <div className="tabs">
          <button className={tab === 'live' ? 'tab active' : 'tab'} onClick={() => setTab('live')}>
            Live TV
          </button>
          <button className={tab === 'movies' ? 'tab active' : 'tab'} onClick={() => setTab('movies')}>
            Movies
          </button>
          <button className={tab === 'series' ? 'tab active' : 'tab'} onClick={() => setTab('series')}>
            Series
          </button>
        </div>
        <div className="top-bar-right">
          {updateMessage && <span className="version-badge">{updateMessage}</span>}
          <span>{session.username}</span>
        </div>
      </div>
      {tab === 'live' && <LiveTv session={session} />}
      {tab === 'movies' && <Movies session={session} />}
      {tab === 'series' && <Series session={session} />}
    </div>
  )
}

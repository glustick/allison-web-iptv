import { useState, type JSX } from 'react'
import { LoginScreen, type Session } from './components/LoginScreen'
import { LiveTv } from './components/LiveTv'
import { Movies } from './components/Movies'
import { Series } from './components/Series'

type Tab = 'live' | 'movies' | 'series'

export default function App(): JSX.Element {
  const [session, setSession] = useState<Session | null>(null)
  const [tab, setTab] = useState<Tab>('live')

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
        <span>{session.username}</span>
      </div>
      {tab === 'live' && <LiveTv session={session} />}
      {tab === 'movies' && <Movies session={session} />}
      {tab === 'series' && <Series session={session} />}
    </div>
  )
}

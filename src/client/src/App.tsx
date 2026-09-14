import { useCallback, useEffect, useRef, useState, type JSX } from 'react'
import { LoginScreen } from './components/LoginScreen'
import { SetupScreen } from './components/SetupScreen'
import { IptvConfigScreen } from './components/IptvConfigScreen'
import { AdminConsole } from './components/AdminConsole'
import { LiveTv } from './components/LiveTv'
import { Movies } from './components/Movies'
import { Series } from './components/Series'
import { formatElapsedTime } from './lib/connectionTiming'
import {
  connectIptv,
  fetchAuthState,
  fetchIptvConfig,
  logout,
  type AppUser,
  type AuthState,
  type IptvConfig,
  type Session
} from './lib/appAuth'

type Tab = 'live' | 'movies' | 'series' | 'admin'

// The post-login IPTV check has three outcomes: no config yet (ask for it), config present
// (auto-connect), or config present but broken (ask for it again, pre-filled, with the
// auto-connect failure shown).
type IptvPhase = 'checking' | 'unconfigured' | 'connecting' | 'failed'

export default function App(): JSX.Element {
  const [authState, setAuthState] = useState<AuthState | null>(null)
  const [session, setSession] = useState<Session | null>(null)
  const [savedConfig, setSavedConfig] = useState<IptvConfig | null>(null)
  const [iptvPhase, setIptvPhase] = useState<IptvPhase>('checking')
  const [autoConnectError, setAutoConnectError] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('live')
  const [updateMessage, setUpdateMessage] = useState<string | null>(null)
  const [elapsedMs, setElapsedMs] = useState(0)
  const connectStartedAtRef = useRef<number | null>(null)

  const refreshAuthState = useCallback(async (): Promise<void> => {
    const state = await fetchAuthState()
    setAuthState(state)
    if (state.authenticated && state.user) {
      const config = await fetchIptvConfig()
      setSavedConfig(config)
      setIptvPhase(config ? 'connecting' : 'unconfigured')
    } else {
      setSavedConfig(null)
    }
  }, [])

  useEffect(() => {
    void refreshAuthState().catch(() => setAuthState({ usersExist: true, authenticated: false, user: null, iptvConfigured: false }))
    void fetch('/api/version-check')
      .then((res) => res.json())
      .then((data) => {
        if (data.updateAvailable) {
          setUpdateMessage(`Update available: ${data.currentVersion} → ${data.latestVersion}`)
        }
      })
      .catch(() => {})
  }, [refreshAuthState])

  // Auto-connect once the IPTV config is known-good on the account; a failure drops the user
  // onto the (pre-filled) config screen instead of getting stuck silently retrying.
  useEffect(() => {
    if (!authState?.authenticated || iptvPhase !== 'connecting' || !savedConfig) return
    let cancelled = false
    connectIptv(savedConfig)
      .then((connected) => {
        if (cancelled) return
        setSession(connected)
        setIptvPhase('checking')
        setAutoConnectError(null)
      })
      .catch((err) => {
        if (cancelled) return
        setAutoConnectError(err instanceof Error ? `Auto-connect failed: ${err.message}` : 'Auto-connect failed')
        setIptvPhase('failed')
      })
    return () => {
      cancelled = true
    }
  }, [authState?.authenticated, iptvPhase, savedConfig])

  // Elapsed-time display while auto-connecting (same UX the old combined login had).
  useEffect(() => {
    if (iptvPhase !== 'connecting') {
      setElapsedMs(0)
      connectStartedAtRef.current = null
      return
    }
    if (connectStartedAtRef.current === null) connectStartedAtRef.current = Date.now()
    const interval = window.setInterval(() => {
      if (connectStartedAtRef.current === null) return
      setElapsedMs(Date.now() - connectStartedAtRef.current)
    }, 250)
    return () => window.clearInterval(interval)
  }, [iptvPhase])

  async function handleLogout(): Promise<void> {
    await logout()
    setSession(null)
    setTab('live')
    setSavedConfig(null)
    setAuthState(null)
    setIptvPhase('checking')
    try {
      await refreshAuthState()
    } catch {
      setAuthState({ usersExist: true, authenticated: false, user: null, iptvConfigured: false })
    }
  }

  function handleAuthAdvanced(): void {
    // Setup/login finished and the server cookie is set — re-read state, then let the IPTV
    // phase machine take over.
    void refreshAuthState().catch(() => setAuthState({ usersExist: true, authenticated: false, user: null, iptvConfigured: false }))
  }

  if (!authState) {
    return (
      <div className="login-screen">
        <div className="login-card">
          <h1>Allison Web IPTV</h1>
          <p className="now-playing-bar">Loading…</p>
        </div>
      </div>
    )
  }

  if (!authState.usersExist) {
    return <SetupScreen onSetupComplete={handleAuthAdvanced} />
  }

  if (!authState.authenticated || !authState.user) {
    return <LoginScreen onLoggedIn={handleAuthAdvanced} />
  }

  const appUser: AppUser = session?.appUser ?? authState.user

  if (!session) {
    if (iptvPhase === 'connecting' && savedConfig) {
      return (
        <div className="login-screen">
          <div className="login-card">
            <h1>Allison Web IPTV</h1>
            <p className="now-playing-bar">Connecting to IPTV… {formatElapsedTime(elapsedMs)}</p>
          </div>
        </div>
      )
    }
    return (
      <IptvConfigScreen
        appUser={appUser}
        initialConfig={savedConfig}
        initialError={iptvPhase === 'failed' ? autoConnectError : null}
        onConnected={(connected) => {
          setSession(connected)
          setIptvPhase('checking')
          setAutoConnectError(null)
        }}
      />
    )
  }

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
          {appUser.role === 'admin' && (
            <button className={tab === 'admin' ? 'tab active' : 'tab'} onClick={() => setTab('admin')}>
              Admin
            </button>
          )}
        </div>
        <div className="top-bar-right">
          {updateMessage && <span className="version-badge">{updateMessage}</span>}
          <span className="user-chip">
            {appUser.username} <span className={`role-badge role-${appUser.role}`}>{appUser.role}</span>
          </span>
          <button type="button" className="logout-btn" onClick={() => void handleLogout()}>
            Sign out
          </button>
        </div>
      </div>
      {tab === 'live' && <LiveTv session={session} />}
      {tab === 'movies' && <Movies session={session} />}
      {tab === 'series' && <Series session={session} />}
      {tab === 'admin' && appUser.role === 'admin' && <AdminConsole appUser={appUser} />}
    </div>
  )
}

import { useCallback, useEffect, useRef, useState, type JSX } from 'react'
import { LoginScreen } from './components/LoginScreen'
import { SetupScreen } from './components/SetupScreen'
import { IptvConfigScreen } from './components/IptvConfigScreen'
import { AdminConsole } from './components/AdminConsole'
import { EpgSettings } from './components/EpgSettings'
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

type Tab = 'live' | 'movies' | 'series' | 'epg' | 'admin'

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
  const [authError, setAuthError] = useState<string | null>(null)
  // An admin whose own account has no IPTV provider configured would otherwise be stuck on
  // the IPTV setup screen, unable to manage users or watch sessions at all — the admin console
  // does not need a provider connection, so it stays reachable on its own.
  const [adminMode, setAdminMode] = useState(false)
  const [elapsedMs, setElapsedMs] = useState(0)
  const connectStartedAtRef = useRef<number | null>(null)

  const refreshAuthState = useCallback(async (): Promise<void> => {
    let state: AuthState
    try {
      state = await fetchAuthState()
      setAuthError(null)
    } catch (err) {
      // Keep the message on-screen: this is usually a data-volume problem (unreadable
      // users.json, read-only mount) and the server said exactly what's wrong.
      setAuthError(err instanceof Error ? err.message : 'Could not reach the server')
      throw err
    }
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
    void refreshAuthState().catch(() => {
      // authError is set and rendered by the branch below — no silent fallback to a login
      // form that could never succeed.
    })
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
    setAdminMode(false)
    setTab('live')
    setSavedConfig(null)
    setAuthState(null)
    setIptvPhase('checking')
    try {
      await refreshAuthState()
    } catch {
      // authError is set and shown; authState cleared so the error branch renders.
      setAuthState(null)
    }
  }

  function handleAuthAdvanced(): void {
    // Setup/login finished and the server cookie is set — re-read state, then let the IPTV
    // phase machine take over.
    void refreshAuthState().catch(() => {})
  }

  if (authError && !authState) {
    return (
      <div className="login-screen">
        <div className="login-card">
          <h1>Allison Web IPTV</h1>
          <div className="login-error">{authError}</div>
          <p className="setup-hint">
            The server couldn't read its account storage. Check the container logs and that the
            data volume is mounted read-write (`./appdata:/appdata:rw`), then retry.
          </p>
          <button type="button" onClick={() => void handleAuthAdvanced()}>
            Retry
          </button>
        </div>
      </div>
    )
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

  const adminOnly = !session && adminMode && appUser.role === 'admin'

  if (!session && !adminOnly) {
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
        onOpenAdmin={
          appUser.role === 'admin'
            ? () => {
                setAdminMode(true)
                setTab('admin')
              }
            : undefined
        }
        onConnected={(connected) => {
          setSession(connected)
          setAdminMode(false)
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
          <button className={tab === 'live' ? 'tab active' : 'tab'} onClick={() => setTab('live')} disabled={!session}>
            Live TV
          </button>
          <button className={tab === 'movies' ? 'tab active' : 'tab'} onClick={() => setTab('movies')} disabled={!session}>
            Movies
          </button>
          <button className={tab === 'series' ? 'tab active' : 'tab'} onClick={() => setTab('series')} disabled={!session}>
            Series
          </button>
          <button className={tab === 'epg' ? 'tab active' : 'tab'} onClick={() => setTab('epg')} disabled={!session}>
            EPG
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
      {!session && (
        <div className="admin-only-notice">
          No IPTV provider is configured for this account, so Live TV, Movies and Series are
          unavailable. Use <strong>Admin</strong> to manage users and watch sessions, or{' '}
          <button type="button" className="link-btn" onClick={() => setAdminMode(false)}>
            set up IPTV
          </button>
          .
        </div>
      )}
      {session && tab === 'live' && <LiveTv session={session} />}
      {session && tab === 'movies' && <Movies session={session} />}
      {session && tab === 'series' && <Series session={session} />}
      {session && tab === 'epg' && <EpgSettings session={session} />}
      {tab === 'admin' && appUser.role === 'admin' && <AdminConsole appUser={appUser} />}
    </div>
  )
}

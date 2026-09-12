import { useEffect, useRef, useState, type JSX } from 'react'
import { formatElapsedTime } from '../lib/connectionTiming'
import { XtreamClient } from '../lib/xtreamClient'

export interface Session {
  client: XtreamClient
  username: string
  server: string
}

interface SavedLogin {
  accessPassword: string
  server: string
  username: string
  password: string
  epgUrls?: string[]
}

interface SavedProfile {
  id: string
  name: string
  credentials: SavedLogin
  epgUrls?: string[]
}

async function loadSavedLogin(): Promise<SavedLogin | null> {
  try {
    const res = await fetch('/api/session')
    if (!res.ok) return null
    const data = (await res.json()) as {
      accessPassword?: string
      server?: string
      username?: string
      password?: string
      epgUrls?: string[]
      sessionId?: string | null
    }
    if (!data.server || !data.username || !data.password || !data.accessPassword) return null
    return {
      accessPassword: data.accessPassword,
      server: data.server,
      username: data.username,
      password: data.password,
      epgUrls: data.epgUrls
    }
  } catch {
    return null
  }
}

async function connect(login: SavedLogin): Promise<Session> {
  const loginRes = await fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: login.accessPassword })
  })
  if (!loginRes.ok) {
    const body = (await loginRes.json().catch(() => ({}))) as { error?: string }
    throw new Error(body.error ?? 'Login failed')
  }

  const connectRes = await fetch('/api/connect', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ server: login.server })
  })
  if (!connectRes.ok) throw new Error('Could not point the server at that Xtream host')

  const client = new XtreamClient(login.username, login.password)
  const auth = await client.authenticate()
  if (auth.user_info.auth !== 1) throw new Error('Invalid Xtream credentials')

  return { client, username: login.username, server: login.server }
}

export function LoginScreen({ onConnected }: { onConnected: (session: Session) => void }): JSX.Element {
  const [saved, setSaved] = useState<SavedLogin | null>(null)
  const [savedProfiles, setSavedProfiles] = useState<SavedProfile[]>([])
  const [activeProfileId, setActiveProfileId] = useState<string | null>(null)
  const [profileName, setProfileName] = useState('')
  const [accessPassword, setAccessPassword] = useState('')
  const [server, setServer] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [epgUrlsText, setEpgUrlsText] = useState('')
  const [connecting, setConnecting] = useState(false)
  const [autoConnecting, setAutoConnecting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [elapsedMs, setElapsedMs] = useState(0)

  async function loadSavedProfiles(): Promise<void> {
    try {
      const res = await fetch('/api/session/profiles')
      if (!res.ok) return
      const data = (await res.json()) as {
        activeProfileId?: string | null
        profiles?: Array<{ id: string; name: string; credentials?: SavedLogin; epgUrls?: string[] }>
      }
      const nextProfiles = (data.profiles ?? []).filter((profile): profile is SavedProfile => {
        if (!profile?.id || !profile.name || !profile.credentials) return false
        const { accessPassword, server, username, password } = profile.credentials
        return !!accessPassword && !!server && !!username && !!password
      })
      setSavedProfiles(nextProfiles)
      setActiveProfileId(data.activeProfileId ?? nextProfiles[0]?.id ?? null)
      const selected = nextProfiles.find((profile) => profile.id === (data.activeProfileId ?? nextProfiles[0]?.id))
      if (selected) {
        setProfileName(selected.name)
        setAccessPassword(selected.credentials.accessPassword)
        setServer(selected.credentials.server)
        setUsername(selected.credentials.username)
        setPassword(selected.credentials.password)
        setEpgUrlsText((selected.epgUrls ?? []).join('\n'))
      }
    } catch {
      // Ignore profile-load failures and just fall back to the editable form.
    }
  }

  useEffect(() => {
    let active = true
    void Promise.all([loadSavedLogin(), loadSavedProfiles()])
      .then(([login]) => {
        if (!active || !login) return
        setSaved(login)
        setAccessPassword(login.accessPassword)
        setServer(login.server)
        setUsername(login.username)
        setPassword(login.password)
        setAutoConnecting(true)
      })
      .catch(() => {})
    return () => {
      active = false
    }
  }, [])
  const startedAtRef = useRef<number | null>(null)

  useEffect(() => {
    if (!connecting && !autoConnecting) {
      setElapsedMs(0)
      startedAtRef.current = null
      return
    }

    if (startedAtRef.current === null) {
      startedAtRef.current = Date.now()
    }

    const interval = window.setInterval(() => {
      if (startedAtRef.current === null) return
      setElapsedMs(Date.now() - startedAtRef.current)
    }, 250)

    return () => window.clearInterval(interval)
  }, [connecting, autoConnecting])

  // Auto-connect once, on mount, only if every field was actually saved from a previous
  // successful login. Falls back to the plain (pre-filled) form on any failure — a changed
  // password, a provider that's temporarily down — rather than getting stuck silently retrying.
  useEffect(() => {
    if (!saved) return
    connect(saved)
      .then(onConnected)
      .catch((err) => {
        setError(err instanceof Error ? `Auto-connect failed: ${err.message}` : 'Auto-connect failed')
        setAutoConnecting(false)
      })
  }, [saved, onConnected])

  function applySavedProfile(profile: SavedProfile): void {
    setActiveProfileId(profile.id)
    setProfileName(profile.name)
    setAccessPassword(profile.credentials.accessPassword)
    setServer(profile.credentials.server)
    setUsername(profile.credentials.username)
    setPassword(profile.credentials.password)
    setEpgUrlsText((profile.epgUrls ?? []).join('\n'))
    setError(null)
  }

  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault()
    setConnecting(true)
    setAutoConnecting(false)
    setError(null)
    setElapsedMs(0)
    const login: SavedLogin = { accessPassword, server, username, password }
    try {
      const session = await connect(login)
      const resolvedProfileId = activeProfileId ?? savedProfiles.find((profile) => profile.credentials.server === server && profile.credentials.username === username)?.id
      const epgUrls = epgUrlsText.split('\n').map((line) => line.trim()).filter((line) => line.length > 0)
      const body = {
        ...login,
        epgUrls,
        profileId: resolvedProfileId ?? undefined,
        profileName: (profileName || username || 'Saved profile').trim()
      }
      await fetch('/api/session/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      })
      await loadSavedProfiles()
      onConnected(session)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Connection failed')
    } finally {
      setConnecting(false)
    }
  }

  async function forgetSavedLogin(): Promise<void> {
    try {
      await fetch('/api/session/clear', { method: 'POST' })
    } catch {
      // Ignore cleanup failures; the UI should still clear the form and continue.
    }
    setSaved(null)
    setAccessPassword('')
    setServer('')
    setUsername('')
    setPassword('')
    setError(null)
  }

  if (autoConnecting) {
    return (
      <div className="login-screen">
        <div className="login-card">
          <h1>Allison Web IPTV</h1>
          <p className="now-playing-bar">Connecting… {formatElapsedTime(elapsedMs)}</p>
        </div>
      </div>
    )
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
        <label>
          Profile name
          <input value={profileName} onChange={(e) => setProfileName(e.target.value)} placeholder="Family main" />
        </label>
        <label>
          Additional EPG guide URLs
          <textarea
            value={epgUrlsText}
            onChange={(e) => setEpgUrlsText(e.target.value)}
            placeholder="https://example.com/epg.xml — one URL per line, optional"
            rows={2}
          />
        </label>
        {savedProfiles.length > 0 && (
          <div className="saved-profile-list">
            <p>Saved profiles</p>
            {savedProfiles.map((profile) => (
              <button
                key={profile.id}
                type="button"
                className={profile.id === activeProfileId ? 'selected-profile' : ''}
                onClick={() => applySavedProfile(profile)}
              >
                {profile.name}
              </button>
            ))}
          </div>
        )}
        <button type="submit" disabled={connecting}>
          {connecting ? `Connecting… ${formatElapsedTime(elapsedMs)}` : 'Connect'}
        </button>
        {saved && (
          <button type="button" className="forget-login-link" onClick={forgetSavedLogin}>
            Forget saved login
          </button>
        )}
      </form>
    </div>
  )
}

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
}

const SAVED_LOGIN_KEY = 'allison-web-iptv:saved-login'

// Deliberately saves the Xtream password (not just server/username) so the app can connect
// automatically on load, per explicit request — this does mean it sits in the browser's
// localStorage in plaintext, same tradeoff as the ACCESS_PASSWORD gate itself. Reasonable for
// this project's own personal/self-hosted scope (see EFFORT-ASSESSMENT.md), not something to
// carry forward if this ever became a real multi-user service.
function loadSavedLogin(): SavedLogin | null {
  try {
    const raw = localStorage.getItem(SAVED_LOGIN_KEY)
    return raw ? (JSON.parse(raw) as SavedLogin) : null
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
  const saved = loadSavedLogin()
  const [accessPassword, setAccessPassword] = useState(saved?.accessPassword ?? '')
  const [server, setServer] = useState(saved?.server ?? '')
  const [username, setUsername] = useState(saved?.username ?? '')
  const [password, setPassword] = useState(saved?.password ?? '')
  const [connecting, setConnecting] = useState(false)
  const [autoConnecting, setAutoConnecting] = useState(Boolean(saved))
  const [error, setError] = useState<string | null>(null)
  const [elapsedMs, setElapsedMs] = useState(0)
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
    // Deliberately runs once on mount only — saved is read once via useState's own lazy
    // initializer above and never changes identity in a way that should re-trigger this.
  }, [])

  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault()
    setConnecting(true)
    setAutoConnecting(false)
    setError(null)
    setElapsedMs(0)
    const login: SavedLogin = { accessPassword, server, username, password }
    try {
      const session = await connect(login)
      localStorage.setItem(SAVED_LOGIN_KEY, JSON.stringify(login))
      onConnected(session)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Connection failed')
    } finally {
      setConnecting(false)
    }
  }

  function forgetSavedLogin(): void {
    localStorage.removeItem(SAVED_LOGIN_KEY)
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

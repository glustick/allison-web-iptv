import { useState, type JSX } from 'react'
import { XtreamClient } from '../lib/xtreamClient'

export interface Session {
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

export function LoginScreen({ onConnected }: { onConnected: (session: Session) => void }): JSX.Element {
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

import { useEffect, useRef, useState, type JSX } from 'react'
import { formatElapsedTime } from '../lib/connectionTiming'
import { connectIptv, saveIptvConfig, type AppUser, type IptvConfig, type Session } from '../lib/appAuth'

// Phase 2 of login: the account is authenticated, now the app checks the IPTV provider
// config. Shown with a blank form when the account has none yet, or pre-filled (with the
// auto-connect failure) when a saved config stopped working.
export function IptvConfigScreen({
  appUser,
  initialConfig,
  initialError,
  onOpenAdmin,
  onConnected
}: {
  appUser: AppUser
  initialConfig: IptvConfig | null
  initialError?: string | null
  /** Admins can reach the admin console without configuring a provider (see App.tsx). */
  onOpenAdmin?: () => void
  onConnected: (session: Session) => void
}): JSX.Element {
  const [server, setServer] = useState(initialConfig?.server ?? '')
  const [username, setUsername] = useState(initialConfig?.username ?? '')
  const [password, setPassword] = useState(initialConfig?.password ?? '')
  const [epgUrlsText, setEpgUrlsText] = useState((initialConfig?.epgUrls ?? []).join('\n'))
  const [connecting, setConnecting] = useState(false)
  const [error, setError] = useState<string | null>(initialError ?? null)
  const [elapsedMs, setElapsedMs] = useState(0)
  const startedAtRef = useRef<number | null>(null)

  useEffect(() => {
    if (!connecting) {
      setElapsedMs(0)
      startedAtRef.current = null
      return
    }
    if (startedAtRef.current === null) startedAtRef.current = Date.now()
    const interval = window.setInterval(() => {
      if (startedAtRef.current === null) return
      setElapsedMs(Date.now() - startedAtRef.current)
    }, 250)
    return () => window.clearInterval(interval)
  }, [connecting])

  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault()
    setConnecting(true)
    setError(null)
    const config: IptvConfig = {
      server: server.trim(),
      username: username.trim(),
      password,
      epgUrls: epgUrlsText.split('\n').map((line) => line.trim()).filter((line) => line.length > 0)
    }
    try {
      await saveIptvConfig(config)
      const session = await connectIptv(config)
      onConnected(session)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Connection failed')
    } finally {
      setConnecting(false)
    }
  }

  return (
    <div className="login-screen">
      <form className="login-card" onSubmit={(e) => void handleSubmit(e)}>
        <h1>IPTV setup</h1>
        <p className="setup-hint">
          Signed in as {appUser.username}. Enter your IPTV provider details — they're stored encrypted on this account.
        </p>
        {error && <div className="login-error">{error}</div>}
        <label>
          IPTV server URL
          <input value={server} onChange={(e) => setServer(e.target.value)} placeholder="https://example.com:8080" required />
        </label>
        <label>
          IPTV username
          <input value={username} onChange={(e) => setUsername(e.target.value)} required />
        </label>
        <label>
          IPTV password
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
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
        <button type="submit" disabled={connecting}>
          {connecting ? `Connecting… ${formatElapsedTime(elapsedMs)}` : 'Save and connect'}
        </button>
        {onOpenAdmin && (
          <button type="button" className="forget-login-link" onClick={onOpenAdmin}>
            Open the admin console without IPTV setup
          </button>
        )}
      </form>
    </div>
  )
}

import { useState, type JSX } from 'react'
import { login, type AppUser } from '../lib/appAuth'

// The app's own login: username and password only. IPTV provider details are intentionally
// NOT asked here — they are checked/configured after this security check (IptvConfigScreen).
export function LoginScreen({ onLoggedIn }: { onLoggedIn: (user: AppUser) => void }): JSX.Element {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault()
    setSubmitting(true)
    setError(null)
    try {
      const user = await login(username.trim(), password)
      onLoggedIn(user)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="login-screen">
      <form className="login-card" onSubmit={(e) => void handleSubmit(e)}>
        <h1>Allison Web IPTV</h1>
        {error && <div className="login-error">{error}</div>}
        <label>
          Username
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" required autoFocus />
        </label>
        <label>
          Password
          <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
            <input
              type={showPassword ? 'text' : 'password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
              style={{ flex: 1, paddingRight: '2.2rem' }}
            />
            {/* v0.116.0 — the eye: TVs and laptops alike mis-key long passwords, and a login
                screen that hides the mistake until the 401 is a bad joke. */}
            <button
              type="button"
              tabIndex={-1}
              aria-label={showPassword ? 'Hide password' : 'Show password'}
              title={showPassword ? 'Hide password' : 'Show password'}
              onClick={() => setShowPassword((value) => !value)}
              style={{
                position: 'absolute', right: 6, background: 'transparent', border: 'none',
                cursor: 'pointer', fontSize: '1rem', color: 'inherit'
              }}
            >
              {showPassword ? '🙈' : '👁'}
            </button>
          </div>
        </label>
        <button type="submit" disabled={submitting}>
          {submitting ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  )
}

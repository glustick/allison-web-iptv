import { useState, type JSX } from 'react'
import { setupAdminAccount, type AppUser } from '../lib/appAuth'

// First-run screen: shown only while the server has zero accounts. Whatever is created here
// becomes the initial admin, who then manages everyone else from the admin panel.
export function SetupScreen({ onSetupComplete }: { onSetupComplete: (user: AppUser) => void }): JSX.Element {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault()
    if (password !== confirmPassword) {
      setError('Passwords do not match')
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      const user = await setupAdminAccount(username.trim(), password)
      onSetupComplete(user)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the admin account')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="login-screen">
      <form className="login-card" onSubmit={(e) => void handleSubmit(e)}>
        <h1>Welcome to Allison Web IPTV</h1>
        <p className="setup-hint">
          First run: create the administrator account. You'll add regular users from the admin panel afterwards.
        </p>
        {error && <div className="login-error">{error}</div>}
        <label>
          Admin username
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" required minLength={3} maxLength={32} />
        </label>
        <label>
          Admin password
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" required minLength={6} />
        </label>
        <label>
          Confirm password
          <input type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} autoComplete="new-password" required />
        </label>
        <button type="submit" disabled={submitting}>
          {submitting ? 'Creating account…' : 'Create admin account'}
        </button>
      </form>
    </div>
  )
}

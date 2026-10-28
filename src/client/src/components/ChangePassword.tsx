import { useState, type JSX } from 'react'
import { changePassword } from '../lib/appAuth'
import { validatePasswordChange } from '../lib/passwordChange'

/**
 * The self-service password change (v0.88.0), as a small modal from the top bar — the first
 * settings surface a non-admin user has ever had in this app. On success the account's OTHER
 * sign-ins end (the changer proved legitimacy by knowing the old password, so this one stays);
 * a wrong current password gets the login lockout's own semantics server-side.
 */
export function ChangePassword({ onClose }: { onClose: () => void }): JSX.Element {
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    setError(null)
    setNote(null)
    const problem = validatePasswordChange(current, next, confirm)
    if (problem) {
      setError(problem)
      return
    }
    setBusy(true)
    try {
      const retired = await changePassword(current, next)
      setNote(
        retired > 0
          ? `Password changed — and ${retired} other sign-in${retired === 1 ? '' : 's'} of this account ${retired === 1 ? 'was' : 'were'} ended.`
          : 'Password changed.'
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not change the password')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="multiview-picker-overlay" onClick={onClose}>
      <form
        className="multiview-picker change-password"
        onClick={(event) => event.stopPropagation()}
        onSubmit={(e) => void submit(e)}
      >
        <div className="multiview-picker-head">
          <strong>Change password</strong>
        </div>
        {error && <div className="login-error">{error}</div>}
        {note && (
          <div className="epg-note">
            {note}{' '}
            <button type="button" className="admin-small-btn" onClick={onClose}>
              Done
            </button>
          </div>
        )}
        {!note && (
          <>
            <label className="change-password-field">
              Current password
              <input
                type="password"
                value={current}
                onChange={(e) => setCurrent(e.target.value)}
                autoComplete="current-password"
                autoFocus
              />
            </label>
            <label className="change-password-field">
              New password
              <input
                type="password"
                value={next}
                onChange={(e) => setNext(e.target.value)}
                autoComplete="new-password"
              />
            </label>
            <label className="change-password-field">
              Confirm new password
              <input
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                autoComplete="new-password"
              />
            </label>
            <div className="multiview-picker-head">
              <span className="admin-muted" style={{ fontSize: 12 }}>
                Changing it ends this account's other sign-ins; this one stays.
              </span>
              <span className="multiview-picker-head">
                <button type="button" className="admin-small-btn" onClick={onClose}>
                  Cancel
                </button>
                <button type="submit" className="admin-small-btn" disabled={busy}>
                  {busy ? 'Changing…' : 'Change password'}
                </button>
              </span>
            </div>
          </>
        )}
      </form>
    </div>
  )
}

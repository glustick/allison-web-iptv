import { useCallback, useEffect, useState, type CSSProperties, type JSX } from 'react'
import type { AppUser, UserRole } from '../lib/appAuth'
import { useResizableColumns, type ColumnSpec } from '../lib/useResizableColumns'

// Column widths are draggable and persisted per table (see useResizableColumns); the tables use
// fixed layout so a drag actually resizes the column, and the panel's text scales with the total
// width so widening the columns makes the content more readable rather than just more spacious.
const SESSION_COLUMNS: ColumnSpec[] = [
  { key: 'user', label: 'User', defaultWidth: 180, min: 80, max: 500 },
  { key: 'role', label: 'Role', defaultWidth: 110, min: 70, max: 300 },
  { key: 'login', label: 'Login time', defaultWidth: 190, min: 120, max: 420 },
  { key: 'duration', label: 'Duration', defaultWidth: 110, min: 70, max: 300 },
  { key: 'playing', label: 'Now playing', defaultWidth: 200, min: 100, max: 520 },
  { key: 'active', label: 'Last active', defaultWidth: 190, min: 120, max: 420 },
  { key: 'actions', label: '', defaultWidth: 110, min: 90, max: 260 }
]

const USER_COLUMNS: ColumnSpec[] = [
  { key: 'username', label: 'Username', defaultWidth: 200, min: 100, max: 520 },
  { key: 'role', label: 'Role', defaultWidth: 160, min: 80, max: 320 },
  { key: 'created', label: 'Created', defaultWidth: 190, min: 120, max: 420 },
  { key: 'lastlogin', label: 'Last login', defaultWidth: 190, min: 120, max: 420 },
  { key: 'actions', label: '', defaultWidth: 110, min: 90, max: 260 }
]

interface AdminSession {
  token: string
  username: string
  role: UserRole
  loginAt: number
  lastSeenAt: number
  durationMs: number
  nowPlaying: { title: string; kind: string } | null
}

interface AdminUser {
  username: string
  role: UserRole
  createdAt: string
  lastLoginAt: string | null
}

const POLL_MS = 5000

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  const pad = (value: number) => String(value).padStart(2, '0')
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`
}

function formatTimestamp(ms: number): string {
  return new Date(ms).toLocaleString()
}

// Admin console, split into the two panels the product needs: who is logged in right now
// (and what they're streaming, since when) and account management (add/remove users).
export function AdminConsole({ appUser }: { appUser: AppUser }): JSX.Element {
  const [sessions, setSessions] = useState<AdminSession[]>([])
  const [users, setUsers] = useState<AdminUser[]>([])
  const [error, setError] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [newUsername, setNewUsername] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [newRole, setNewRole] = useState<UserRole>('user')
  const [formError, setFormError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  // Provider-alert settings (see the server's /api/admin/alerts).
  const [alertInfo, setAlertInfo] = useState<{ webhookSet: boolean; watching: boolean; state: string; host: string | null } | null>(null)
  const [webhookDraft, setWebhookDraft] = useState('')
  const [alertBusy, setAlertBusy] = useState(false)
  const [alertNote, setAlertNote] = useState<string | null>(null)
  const [alertError, setAlertError] = useState<string | null>(null)
  // Inline password reset: the app had no way to change a password after creation, so a typo
  // locked an account out permanently with delete-and-recreate as the only remedy.
  const [passwordTarget, setPasswordTarget] = useState<string | null>(null)
  const [passwordValue, setPasswordValue] = useState('')
  const [passwordBusy, setPasswordBusy] = useState(false)

  const sessionCols = useResizableColumns('admin-sessions', SESSION_COLUMNS)
  const userCols = useResizableColumns('admin-users', USER_COLUMNS)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const [sessionsRes, usersRes, alertsRes] = await Promise.all([
        fetch('/api/admin/sessions'),
        fetch('/api/admin/users'),
        fetch('/api/admin/alerts')
      ])
      if (sessionsRes.status === 401 || sessionsRes.status === 403) {
        window.location.reload()
        return
      }
      if (!sessionsRes.ok || !usersRes.ok) throw new Error('Admin data request failed')
      const sessionsData = (await sessionsRes.json()) as { sessions: AdminSession[] }
      const usersData = (await usersRes.json()) as { users: AdminUser[] }
      setSessions(sessionsData.sessions)
      setUsers(usersData.users)
        if (alertsRes.ok) setAlertInfo((await alertsRes.json()) as typeof alertInfo)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load admin data')
    }
  }, [])

  useEffect(() => {
    void refresh()
    const poll = window.setInterval(() => void refresh(), POLL_MS)
    const tick = window.setInterval(() => setNow(Date.now()), 1000)
    return () => {
      window.clearInterval(poll)
      window.clearInterval(tick)
    }
  }, [refresh])

  async function forceLogout(token: string): Promise<void> {
    try {
      const res = await fetch(`/api/admin/sessions/${encodeURIComponent(token)}/logout`, { method: 'POST' })
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(data.error ?? 'Could not sign that session out')
      }
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not sign that session out')
    }
  }

  async function handleAddUser(e: React.FormEvent): Promise<void> {
    e.preventDefault()
    setAdding(true)
    setFormError(null)
    try {
      const res = await fetch('/api/admin/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: newUsername.trim(), password: newPassword, role: newRole })
      })
      const data = (await res.json().catch(() => ({}))) as { error?: string }
      if (!res.ok) throw new Error(data.error ?? 'Could not create the user')
      setNewUsername('')
      setNewPassword('')
      setNewRole('user')
      await refresh()
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Could not create the user')
    } finally {
      setAdding(false)
    }
  }

  async function handleSetPassword(username: string): Promise<void> {
    if (passwordValue.length < 6) {
      setError('The new password must be at least 6 characters')
      return
    }
    setPasswordBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/admin/users/${encodeURIComponent(username)}/password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: passwordValue })
      })
      const data = (await res.json().catch(() => ({}))) as { error?: string }
      if (!res.ok) throw new Error(data.error ?? 'Could not set the password')
      setPasswordTarget(null)
      setPasswordValue('')
      setNote(`Password updated for ${username}.`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not set the password')
    } finally {
      setPasswordBusy(false)
    }
  }

  async function handleRemoveUser(username: string): Promise<void> {
    try {
      const res = await fetch(`/api/admin/users/${encodeURIComponent(username)}`, { method: 'DELETE' })
      const data = (await res.json().catch(() => ({}))) as { error?: string }
      if (!res.ok) throw new Error(data.error ?? 'Could not remove the user')
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not remove the user')
    }
  }

  async function saveAlertWebhook(): Promise<void> {
    setAlertBusy(true); setAlertError(null); setAlertNote(null)
    try {
      const res = await fetch('/api/admin/alerts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ webhook: webhookDraft.trim() })
      })
      const data = (await res.json().catch(() => ({}))) as { error?: string; webhookSet?: boolean; watching?: boolean }
      if (!res.ok) throw new Error(data.error ?? 'Could not save the webhook')
      setWebhookDraft('')
      setAlertNote(
        data.watching
          ? 'Saved — the watchdog is watching your provider and will post here if it stops answering.'
          : 'Saved.'
      )
      await refresh()
    } catch (err) {
      setAlertError(err instanceof Error ? err.message : 'Could not save the webhook')
    } finally {
      setAlertBusy(false)
    }
  }

  async function clearAlertWebhook(): Promise<void> {
    setAlertBusy(true); setAlertError(null); setAlertNote(null)
    try {
      const res = await fetch('/api/admin/alerts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ webhook: null })
      })
      if (!res.ok) throw new Error('Could not remove the webhook')
      setAlertNote('Removed — no alerts will be posted.')
      await refresh()
    } catch (err) {
      setAlertError(err instanceof Error ? err.message : 'Could not remove the webhook')
    } finally {
      setAlertBusy(false)
    }
  }

  async function sendTestAlert(): Promise<void> {
    setAlertBusy(true); setAlertError(null); setAlertNote(null)
    try {
      const res = await fetch('/api/alerts/test', { method: 'POST' })
      const data = (await res.json().catch(() => ({}))) as { error?: string; delivered?: boolean }
      if (!res.ok) throw new Error(data.error ?? 'Could not send the test')
      setAlertNote(data.delivered ? 'Test message delivered to Discord.' : 'Discord refused the test — check the webhook URL.')
    } catch (err) {
      setAlertError(err instanceof Error ? err.message : 'Could not send the test')
    } finally {
      setAlertBusy(false)
    }
  }

  return (
    <div className="admin-console">
      {error && <div className="login-error admin-error">{error}</div>}
      {note && <div className="epg-note">{note}</div>}

      <section className="admin-section">
        <div className="epg-section-head">
          <h2>Active sessions</h2>
          <button type="button" className="admin-small-btn" onClick={() => sessionCols.reset()}>
            Reset columns
          </button>
        </div>
        <div className="admin-table-wrap">
          <table
            className="admin-table admin-table--fixed"
            style={{ '--table-font-scale': sessionCols.fontScale } as CSSProperties}
          >
            <thead>
              <tr>
                {SESSION_COLUMNS.map((column) => (
                  <th key={column.key} style={{ width: `${sessionCols.percent[column.key]}%` }}>
                    {column.label}
                    <span
                      className="col-resize"
                      onPointerDown={sessionCols.startDrag(column.key)}
                      onDoubleClick={() => sessionCols.reset(column.key)}
                      title="Drag to resize · double-click to reset"
                    />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sessions.length === 0 && (
                <tr>
                  <td colSpan={7} className="admin-empty">No active sessions — users appear here as soon as they sign in</td>
                </tr>
              )}
              {sessions.map((session) => (
                <tr key={session.token}>
                  <td>{session.username}</td>
                  <td><span className={`role-badge role-${session.role}`}>{session.role}</span></td>
                  <td>{formatTimestamp(session.loginAt)}</td>
                  <td>{formatDuration(now - session.loginAt)}</td>
                  <td>
                    {session.nowPlaying ? (
                      <span className="now-playing-cell">
                        {session.nowPlaying.title} <span className={`kind-tag kind-${session.nowPlaying.kind}`}>{session.nowPlaying.kind}</span>
                      </span>
                    ) : (
                      <span className="admin-muted">—</span>
                    )}
                  </td>
                  <td>{formatTimestamp(session.lastSeenAt)}</td>
                  <td>
                    <button type="button" className="admin-small-btn" onClick={() => void forceLogout(session.token)}>
                      Sign out
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="admin-section">
        <div className="epg-section-head">
          <h2>Users</h2>
          <button type="button" className="admin-small-btn" onClick={() => userCols.reset()}>
            Reset columns
          </button>
        </div>
        <div className="admin-table-wrap">
          <table
            className="admin-table admin-table--fixed"
            style={{ '--table-font-scale': userCols.fontScale } as CSSProperties}
          >
            <thead>
              <tr>
                {USER_COLUMNS.map((column) => (
                  <th key={column.key} style={{ width: `${userCols.percent[column.key]}%` }}>
                    {column.label}
                    <span
                      className="col-resize"
                      onPointerDown={userCols.startDrag(column.key)}
                      onDoubleClick={() => userCols.reset(column.key)}
                      title="Drag to resize · double-click to reset"
                    />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {users.map((user) => (
                <tr key={user.username}>
                  <td>{user.username}{user.username === appUser.username && <span className="you-tag">you</span>}</td>
                  <td><span className={`role-badge role-${user.role}`}>{user.role}</span></td>
                  <td>{new Date(user.createdAt).toLocaleString()}</td>
                  <td>{user.lastLoginAt ? new Date(user.lastLoginAt).toLocaleString() : <span className="admin-muted">never</span>}</td>
                  <td className="user-actions">
                    {passwordTarget === user.username ? (
                      <>
                        <input
                          type="password"
                          className="inline-pass"
                          value={passwordValue}
                          onChange={(e) => setPasswordValue(e.target.value)}
                          placeholder="New password"
                          autoComplete="new-password"
                          autoFocus
                        />
                        <button
                          type="button"
                          className="admin-small-btn"
                          onClick={() => void handleSetPassword(user.username)}
                          disabled={passwordBusy}
                        >
                          Save
                        </button>
                        <button
                          type="button"
                          className="admin-small-btn"
                          onClick={() => {
                            setPasswordTarget(null)
                            setPasswordValue('')
                          }}
                        >
                          Cancel
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          className="admin-small-btn"
                          onClick={() => {
                            setPasswordTarget(user.username)
                            setPasswordValue('')
                            setNote(null)
                            setError(null)
                          }}
                        >
                          Set password
                        </button>
                        {user.username !== appUser.username && (
                          <button type="button" className="admin-small-btn danger" onClick={() => void handleRemoveUser(user.username)}>
                            Remove
                          </button>
                        )}
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <form className="add-user-form" onSubmit={(e) => void handleAddUser(e)}>
          <h3>Add user</h3>
          {formError && <div className="login-error">{formError}</div>}
          <div className="add-user-row">
            <label>
              Username
              <input value={newUsername} onChange={(e) => setNewUsername(e.target.value)} required minLength={3} maxLength={32} autoComplete="off" />
            </label>
            <label>
              Password
              <input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} required minLength={6} autoComplete="new-password" />
            </label>
            <label>
              Role
              <select value={newRole} onChange={(e) => setNewRole(e.target.value as UserRole)}>
                <option value="user">user</option>
                <option value="admin">admin</option>
              </select>
            </label>
            <button type="submit" disabled={adding}>
              {adding ? 'Adding…' : 'Add user'}
            </button>
          </div>
        </form>
      </section>
        <section className="admin-section">
          <div className="epg-section-head">
            <h2>Provider alerts</h2>
            {alertInfo && (
              <span className="admin-muted">
                {alertInfo.watching ? `watching ${alertInfo.host ?? 'the provider'} — ${alertInfo.state}` : 'not watching'}
              </span>
            )}
          </div>
          <p className="setup-hint">
            When the provider stops answering, the server posts to this Discord webhook — once when it goes
            down and once when it recovers, never repeatedly while it stays down. The message names the host
            and the error, never your account.
          </p>
          {alertError && <div className="login-error admin-error">{alertError}</div>}
          {alertNote && <div className="epg-note">{alertNote}</div>}
          <div className="add-user-row">
            <label>
              Discord webhook URL
              <input
                type="text"
                autoComplete="off"
                spellCheck={false}
                value={webhookDraft}
                onChange={(e) => setWebhookDraft(e.target.value)}
                placeholder={
                  alertInfo?.webhookSet ? '•••••• saved — leave blank to keep it' : 'https://discord.com/api/webhooks/…'
                }
                style={{ width: 460 }}
              />
            </label>
            <button type="button" onClick={() => void saveAlertWebhook()} disabled={alertBusy}>
              {alertBusy ? 'Saving…' : 'Save'}
            </button>
            <button
              type="button"
              className="admin-small-btn"
              onClick={() => void sendTestAlert()}
              disabled={alertBusy || !alertInfo?.webhookSet}
              title={
                alertInfo?.webhookSet
                  ? 'Post a test message to the channel'
                  : 'Save a webhook first — then this proves delivery'
              }
            >
              Send test alert
            </button>
            {alertInfo?.webhookSet && (
              <button
                type="button"
                className="admin-small-btn danger"
                onClick={() => void clearAlertWebhook()}
                disabled={alertBusy}
              >
                Remove
              </button>
            )}
          </div>
        </section>
    </div>
  )
}

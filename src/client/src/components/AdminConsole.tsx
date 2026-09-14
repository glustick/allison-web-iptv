import { useCallback, useEffect, useState, type JSX } from 'react'
import type { AppUser, UserRole } from '../lib/appAuth'

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

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const [sessionsRes, usersRes] = await Promise.all([fetch('/api/admin/sessions'), fetch('/api/admin/users')])
      if (sessionsRes.status === 401 || sessionsRes.status === 403) {
        window.location.reload()
        return
      }
      if (!sessionsRes.ok || !usersRes.ok) throw new Error('Admin data request failed')
      const sessionsData = (await sessionsRes.json()) as { sessions: AdminSession[] }
      const usersData = (await usersRes.json()) as { users: AdminUser[] }
      setSessions(sessionsData.sessions)
      setUsers(usersData.users)
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

  return (
    <div className="admin-console">
      {error && <div className="login-error admin-error">{error}</div>}

      <section className="admin-section">
        <h2>Active sessions</h2>
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>User</th>
                <th>Role</th>
                <th>Login time</th>
                <th>Duration</th>
                <th>Now playing</th>
                <th>Last active</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {sessions.length === 0 && (
                <tr>
                  <td colSpan={7} className="admin-empty">No one is logged in right now</td>
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
        <h2>Users</h2>
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Username</th>
                <th>Role</th>
                <th>Created</th>
                <th>Last login</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {users.map((user) => (
                <tr key={user.username}>
                  <td>{user.username}{user.username === appUser.username && <span className="you-tag">you</span>}</td>
                  <td><span className={`role-badge role-${user.role}`}>{user.role}</span></td>
                  <td>{new Date(user.createdAt).toLocaleString()}</td>
                  <td>{user.lastLoginAt ? new Date(user.lastLoginAt).toLocaleString() : <span className="admin-muted">never</span>}</td>
                  <td>
                    {user.username !== appUser.username && (
                      <button type="button" className="admin-small-btn danger" onClick={() => void handleRemoveUser(user.username)}>
                        Remove
                      </button>
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
    </div>
  )
}

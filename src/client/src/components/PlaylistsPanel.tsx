import { useCallback, useEffect, useState } from 'react'

/**
 * The playlists manager, in the admin console.
 *
 * The operator's plan (2026-09-23): two **different** Xtream profiles for redundancy, shown side by side
 * in the channel list, with no automatic merging and no automatic failover — they pick. This is the
 * screen that configures them; the channel-list work (a Playlist column, hide and sort) is the next
 * step, and nothing here depends on it.
 *
 * Two rules it keeps, both mirroring the server:
 *
 * - **Passwords never come back from the server.** A blank password field means "keep the stored one",
 *   which is why the rows carry a `passwordSet` flag rather than a value — the browser is never handed
 *   a secret it does not need, and cannot leak one it was never given.
 * - **Saving is whole-list and explicit.** There is no per-row save, so what you see is what is stored;
 *   an account's guide URLs and alert webhook are untouched, because the server merges this list into
 *   the envelope rather than replacing it.
 */
interface PlaylistRow {
  /** Server-assigned for an existing playlist; empty for a row that has not been saved yet. */
  id: string
  label: string
  server: string
  username: string
  /** True when a password is stored server-side. */
  passwordSet: boolean
  /** Only ever what the operator just typed — never a value that came from the server. */
  password: string
  /** A stable React key for an unsaved row, which has no id yet. */
  key: string
}

function toRows(playlists: Array<Omit<PlaylistRow, 'password' | 'key'>>): PlaylistRow[] {
  return playlists.map((playlist) => ({
    id: playlist.id,
    label: playlist.label,
    server: playlist.server,
    username: playlist.username,
    passwordSet: playlist.passwordSet,
    password: '',
    key: playlist.id
  }))
}

export function PlaylistsPanel() {
  const [rows, setRows] = useState<PlaylistRow[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const response = await fetch('/api/iptv/playlists')
      const body = (await response.json()) as { playlists?: Array<Omit<PlaylistRow, 'password' | 'key'>>; error?: string }
      if (!response.ok) throw new Error(body.error ?? `Could not load playlists (${response.status})`)
      setRows(toRows(body.playlists ?? []))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load playlists')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  function patchRow(key: string, patch: Partial<PlaylistRow>): void {
    setRows((current) => current.map((row) => (row.key === key ? { ...row, ...patch } : row)))
    setNote(null)
  }

  function addRow(): void {
    setRows((current) => [
      ...current,
      { id: '', label: '', server: '', username: '', passwordSet: false, password: '', key: `new-${Date.now()}` }
    ])
    setNote(null)
  }

  function removeRow(key: string): void {
    setRows((current) => current.filter((row) => row.key !== key))
    setNote(null)
  }

  async function save(): Promise<void> {
    setSaving(true)
    setError(null)
    setNote(null)
    try {
      const response = await fetch('/api/iptv/playlists', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          playlists: rows.map((row) => ({
            id: row.id,
            label: row.label,
            server: row.server,
            username: row.username,
            password: row.password
          }))
        })
      })
      const body = (await response.json()) as { playlists?: Array<Omit<PlaylistRow, 'password' | 'key'>>; error?: string }
      if (!response.ok) throw new Error(body.error ?? `Could not save playlists (${response.status})`)
      setRows(toRows(body.playlists ?? []))
      setNote(`Saved ${body.playlists?.length ?? 0} playlist${(body.playlists?.length ?? 0) === 1 ? '' : 's'}.`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save playlists')
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="admin-section">
      <h2>Playlists</h2>
      <p className="setup-hint">
        The Xtream profiles this account can play from — two different providers for redundancy, listed
        side by side in the channel list. Nothing is merged and nothing fails over automatically: you
        choose which playlist to watch. The first one listed is the primary, which the guide, the search
        index and the provider checks follow.
      </p>

      {loading && <p className="setup-hint">Loading…</p>}

      {rows.map((row, index) => (
        <div key={row.key} className="admin-table-wrap" style={{ marginBottom: 8 }}>
          <div className="epg-section-actions" style={{ flexWrap: 'wrap' }}>
            <input
              type="text"
              value={row.label}
              placeholder={index === 0 ? 'Label (e.g. Main)' : 'Label (e.g. Backup)'}
              aria-label="Playlist label"
              onChange={(event) => patchRow(row.key, { label: event.target.value })}
              style={{ minWidth: 140 }}
            />
            <input
              type="text"
              value={row.server}
              placeholder="Server (https://…)"
              aria-label="Provider server"
              onChange={(event) => patchRow(row.key, { server: event.target.value })}
              style={{ minWidth: 240 }}
            />
            <input
              type="text"
              value={row.username}
              placeholder="Username"
              aria-label="Provider username"
              onChange={(event) => patchRow(row.key, { username: event.target.value })}
              style={{ minWidth: 140 }}
            />
            <input
              type="password"
              value={row.password}
              placeholder={row.passwordSet ? '•••••• (unchanged)' : 'Password'}
              aria-label="Provider password"
              onChange={(event) => patchRow(row.key, { password: event.target.value })}
              style={{ minWidth: 140 }}
            />
            <button type="button" className="admin-small-btn" onClick={() => removeRow(row.key)}>
              Remove
            </button>
          </div>
        </div>
      ))}

      {!loading && rows.length === 0 && (
        <p className="setup-hint">
          No playlists configured on this account yet — the provider setup screen writes the first one.
        </p>
      )}

      <div className="epg-section-actions">
        <button type="button" className="admin-small-btn" onClick={addRow}>
          Add a playlist
        </button>
        <button type="button" className="admin-small-btn" onClick={() => void save()} disabled={saving}>
          {saving ? 'Saving…' : 'Save playlists'}
        </button>
      </div>

      {note && <p className="setup-hint">{note}</p>}
      {error && <p className="player-error">{error}</p>}
    </section>
  )
}

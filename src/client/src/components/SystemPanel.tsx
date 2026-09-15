import { useCallback, useEffect, useState, type JSX } from 'react'
import { backupDownloadUrl, fetchHealth, reindexSearch, uploadRestore, type HealthReport } from '../lib/system'

// System tab (admins): the questions that used to take a dozen messages to answer — is the
// provider up? are the guide sources healthy? are transcodes still running? how big is the
// database, and what actually errored? — plus backup/restore and the search index controls.

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes}m`
}

function formatBytesShort(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

export function SystemPanel(): JSX.Element {
  const [health, setHealth] = useState<HealthReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setHealth(await fetchHealth())
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load system health')
    }
  }, [])

  useEffect(() => {
    void refresh()
    const timer = window.setInterval(() => void refresh(), 15000)
    return () => window.clearInterval(timer)
  }, [refresh])

  async function handleReindex(): Promise<void> {
    setBusy(true)
    setNote('Rebuilding the search index — this pulls the provider catalogue and can take a while…')
    try {
      const index = await reindexSearch()
      setNote(index.lastError ? `Index build finished with an error: ${index.lastError}` : `Indexed ${index.total.toLocaleString()} items.`)
      await refresh()
    } catch (err) {
      setNote(err instanceof Error ? err.message : 'Could not rebuild the index')
    } finally {
      setBusy(false)
    }
  }

  async function handleRestore(file: File): Promise<void> {
    setBusy(true)
    setNote(null)
    try {
      const result = await uploadRestore(file)
      setNote(
        result.requiresRestart
          ? 'Backup uploaded and verified. Restart the container (docker compose restart) to apply it — the database being replaced is kept in /appdata/backups.'
          : 'Uploaded.'
      )
      await refresh()
    } catch (err) {
      setNote(err instanceof Error ? err.message : 'Restore failed')
    } finally {
      setBusy(false)
    }
  }

  const provider = health?.provider ?? {}
  const providerDown = provider.reachable === false

  return (
    <div className="admin-console">
      {error && <div className="login-error admin-error">{error}</div>}
      {note && <div className="epg-note">{note}</div>}

      <section className="admin-section">
        <div className="epg-section-head">
          <h2>Server</h2>
          <button type="button" className="admin-small-btn" onClick={() => void refresh()}>
            Refresh
          </button>
        </div>
        <div className="epg-stats">
          <div className="epg-stat">
            <span className="epg-stat-value">{health?.server.version ?? '—'}</span>
            <span className="epg-stat-label">version</span>
          </div>
          <div className="epg-stat">
            <span className="epg-stat-value">{health ? formatUptime(health.server.uptimeSeconds) : '—'}</span>
            <span className="epg-stat-label">uptime</span>
          </div>
          <div className="epg-stat">
            <span className="epg-stat-value">{health ? `${health.server.memoryMb} MB` : '—'}</span>
            <span className="epg-stat-label">memory (RSS)</span>
          </div>
          <div className="epg-stat">
            <span className="epg-stat-value">{health?.database.sizeLabel ?? '—'}</span>
            <span className="epg-stat-label">database</span>
          </div>
        </div>
        <p className="setup-hint">
          {health ? `${health.server.node} · ${health.server.platform} · ${health.database.path}` : 'Loading…'}
        </p>
      </section>

      <section className="admin-section">
        <h2>Provider</h2>
        <div className="admin-table-wrap">
          <table className="admin-table">
            <tbody>
              <tr>
                <td>Reachable</td>
                <td>{provider.configured === false ? 'no IPTV config on this account' : providerDown ? 'no — unreachable right now' : provider.reachable ? 'yes' : '—'}</td>
              </tr>
              <tr>
                <td>Account</td>
                <td>{String(provider.status ?? '—')} (auth {String(provider.auth ?? '—')})</td>
              </tr>
              <tr>
                <td>Connections</td>
                <td>
                  {String(provider.activeConnections ?? '—')} in use of {String(provider.maxConnections ?? '—')}
                </td>
              </tr>
              <tr>
                <td>Expires</td>
                <td>
                  {typeof provider.expiresAt === 'string' && /^\d+$/.test(provider.expiresAt)
                    ? new Date(Number(provider.expiresAt) * 1000).toLocaleDateString()
                    : '—'}
                </td>
              </tr>
              {providerDown && (
                <tr>
                  <td>Error</td>
                  <td className="admin-muted">{String(provider.error ?? '')}</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="admin-section">
        <h2>Guide sources</h2>
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Source</th>
                <th>Status</th>
                <th>Guide channels</th>
                <th>Programmes</th>
              </tr>
            </thead>
            <tbody>
              {(health?.guide ?? []).map((source, index) => (
                <tr key={`${source.kind}-${index}`}>
                  <td>{source.kind === 'provider' ? 'Provider guide' : source.url.slice(0, 60)}</td>
                  <td>
                    <span className={`epg-status epg-status-${source.status}`}>{source.status}</span>
                  </td>
                  <td>{source.channelCount.toLocaleString()}</td>
                  <td>{source.programmeCount.toLocaleString()}</td>
                </tr>
              ))}
              {health && (health.guide ?? []).length === 0 && (
                <tr>
                  <td colSpan={4} className="admin-empty">
                    No guide sources configured
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="admin-section">
        <div className="epg-section-head">
          <h2>Search index</h2>
          <button type="button" className="admin-small-btn" onClick={() => void handleReindex()} disabled={busy}>
            {health?.search.indexing ? 'Indexing…' : 'Rebuild index'}
          </button>
        </div>
        <div className="epg-stats">
          <div className="epg-stat">
            <span className="epg-stat-value">{health?.search.total.toLocaleString() ?? '—'}</span>
            <span className="epg-stat-label">items indexed</span>
          </div>
          <div className="epg-stat">
            <span className="epg-stat-value">{health?.search.live.toLocaleString() ?? '—'}</span>
            <span className="epg-stat-label">live channels</span>
          </div>
          <div className="epg-stat">
            <span className="epg-stat-value">{health?.search.movie.toLocaleString() ?? '—'}</span>
            <span className="epg-stat-label">films</span>
          </div>
          <div className="epg-stat">
            <span className="epg-stat-value">{health?.search.series.toLocaleString() ?? '—'}</span>
            <span className="epg-stat-label">series</span>
          </div>
        </div>
        {health?.search.lastError && <p className="setup-hint">Last index error: {health.search.lastError}</p>}
        <p className="setup-hint">
          The index is rebuilt automatically when it is older than a day; a rebuild needs the provider to be reachable.
        </p>
      </section>

      <section className="admin-section">
        <h2>Active transcodes</h2>
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Session</th>
                <th>Running</th>
                <th>Output</th>
                <th>Disk used</th>
              </tr>
            </thead>
            <tbody>
              {(health?.transcode.active ?? []).map((session) => (
                <tr key={session.sessionId}>
                  <td>{session.sessionId}</td>
                  <td>{session.runningSeconds}s</td>
                  <td>{session.hasPlaylist ? 'playlist ready' : 'starting'}</td>
                  <td>{formatBytesShort(session.bytes)}</td>
                </tr>
              ))}
              {health && health.transcode.active.length === 0 && (
                <tr>
                  <td colSpan={4} className="admin-empty">
                    None running
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {health && (
          <p className="setup-hint">
            Segments are written to <code>{health.transcode.storage.dir}</code>
            {health.transcode.storage.freeBytes !== null
              ? ` — ${formatBytesShort(health.transcode.storage.freeBytes)} free there.`
              : ' (free space unavailable).'}{' '}
            A movie keeps every segment while it plays, so a feature-length title can use several
            gigabytes; point <code>TRANSCODE_TMP_DIR</code> somewhere roomy if that is a problem.
          </p>
        )}
      </section>

      <section className="admin-section">
        <h2>Backup &amp; restore</h2>
        <p className="setup-hint">
          The database holds every account, credential, favourite, category and resume point. A daily snapshot is written to
          <code> /appdata/backups</code> automatically; download one here, or restore an uploaded one on the next restart.
        </p>
        <div className="epg-section-actions">
          <a className="admin-small-btn" href={backupDownloadUrl()}>
            Download backup
          </a>
          <label className="admin-small-btn restore-label">
            Restore from file…
            <input
              type="file"
              accept=".db,application/octet-stream"
              disabled={busy}
              onChange={(e) => {
                const file = e.target.files?.[0]
                e.target.value = ''
                if (file) void handleRestore(file)
              }}
            />
          </label>
        </div>
        {(health?.backups ?? []).length > 0 && (
          <div className="admin-table-wrap" style={{ marginTop: 12 }}>
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Snapshot</th>
                  <th>Size</th>
                  <th>Taken</th>
                </tr>
              </thead>
              <tbody>
                {(health?.backups ?? []).map((backup) => (
                  <tr key={backup.name}>
                    <td>{backup.name}</td>
                    <td>{formatBytesShort(backup.bytes)}</td>
                    <td>{new Date(backup.modifiedAt).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="admin-section">
        <h2>Recent errors</h2>
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>When</th>
                <th>Message</th>
              </tr>
            </thead>
            <tbody>
              {(health?.errors ?? []).map((entry, index) => (
                <tr key={`${entry.at}-${index}`}>
                  <td>{new Date(entry.at).toLocaleTimeString()}</td>
                  <td>{entry.message}</td>
                </tr>
              ))}
              {health && health.errors.length === 0 && (
                <tr>
                  <td colSpan={2} className="admin-empty">
                    Nothing logged since the server started
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}

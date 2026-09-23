import { useCallback, useEffect, useState, type JSX } from 'react'
import { EPG_PRESETS, guideUrlsWithPreset, presetById } from '../lib/epgPresets'
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

/** Bytes/second to Mbps, one decimal — the units someone thinking about their LAN actually uses. */
function mbpsFromBytesPerSecond(bytesPerSecond: number): string {
  return `${(Math.round((bytesPerSecond * 8) / 100000) / 10).toFixed(1)} Mbps`
}

function formatBytesShort(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

import { sourceLabel } from '../lib/sourceLabel'
import { DecoderCheck } from './DecoderCheck'
export function SystemPanel(): JSX.Element {
  const [health, setHealth] = useState<HealthReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [presetId, setPresetId] = useState(EPG_PRESETS[0]?.id ?? '')

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

  // Public guides, verified rather than remembered (see lib/epgPresets.ts). The endpoint replaces
  // the external list, so the existing sources are carried through with the new one appended.
  const addPreset = async (): Promise<void> => {
    const preset = presetById(presetId)
    if (!preset) return
    setBusy(true)
    setNote(null)
    try {
      const current = (health?.guide ?? []).filter((source) => source.kind !== 'provider').map((source) => source.url)
      const res = await fetch('/api/epg/sources', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ epgUrls: guideUrlsWithPreset(current, preset) })
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? `Could not add it (HTTP ${res.status})`)
      }
      await fetch('/api/epg/refresh', { method: 'POST' })
      setNote(`${preset.label} added — the guide is refreshing now.`)
      await refresh()
    } catch (err) {
      setNote(err instanceof Error ? err.message : 'Could not add the guide')
    } finally {
      setBusy(false)
    }
  }

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
          {health?.database.freeBytes != null ? ` · ${formatBytesShort(health.database.freeBytes)} free` : ''}
        </p>
        {health?.database.lowSpace && (
          <p className="setup-error" role="alert">
            Only {formatBytesShort(health.database.freeBytes ?? 0)} free on the filesystem holding the
            database. A full disk makes SQLite report <code>disk I/O error</code> — which looks like
            corruption or permissions, and is neither. Free space on the host:
            <code> docker image prune -a</code> reclaims unused images.
          </p>
        )}
        {health?.database.ok === false && (
          <p className="setup-error" role="alert">
            The database is <strong>not writable</strong> ({health.database.error}). Sign-in and every
            other write will fail until this is fixed. The server runs as uid 1000, so on a host
            directory created by an earlier root-running build:
            <code> sudo chown -R 1000:1000 &lt;your appdata dir&gt;</code> — then{' '}
            <strong>restart the container</strong>, because SQLite fixes its write mode when it opens
            the file.
          </p>
        )}
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
                  <td title={source.kind === 'provider' ? undefined : source.url}>
                  {/* In full, so a wider column actually reveals it; the provider's own guide is named
                      because its URL carries the account credentials in the query. */}
                  {sourceLabel(source.url, source.kind)}
                </td>
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

          {/* Public guides that were verified working, so nobody has to hunt for a URL and discover
              it is dead. Short on purpose — see lib/epgPresets.ts for the date each was checked. */}
          <div className="epg-preset-row">
            <label htmlFor="epg-preset">Add a public guide</label>
            <select
              id="epg-preset"
              value={presetId}
              onChange={(event) => setPresetId(event.target.value)}
              disabled={busy}
            >
              {EPG_PRESETS.map((preset) => (
                <option key={preset.id} value={preset.id}>
                  {preset.label} — checked {preset.verified}
                </option>
              ))}
            </select>
            <button type="button" onClick={() => void addPreset()} disabled={busy}>
              {busy ? 'Adding…' : 'Add as a guide source'}
            </button>
          </div>
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
                <th title="Average output rate since this session started. Every live segment is relayed through this host, so this is the bandwidth it is carrying for one viewer.">Rate</th>
                <th title="Seconds since anything fetched this session's output; the server stops a session after 120s">Idle</th>
              </tr>
            </thead>
            <tbody>
              {(health?.transcode.active ?? []).map((session) => (
                <tr key={session.sessionId}>
                  <td>{session.sessionId}</td>
                  <td>{session.runningSeconds}s</td>
                  <td>{session.hasPlaylist ? 'playlist ready' : 'starting'}</td>
                  <td>{formatBytesShort(session.bytes)}</td>
                  <td>
                    {session.bytesPerSecond !== null ? mbpsFromBytesPerSecond(session.bytesPerSecond) : '—'}
                  </td>
                  {/* The number that explained every hard playback bug on 2026-09-17: a session nothing is
                      fetching is a session nobody is watching, and the server reaps it at 120 seconds. Visible
                      here so it is a fact rather than a black screen. */}
                  <td>
                    {session.idleSeconds}s
                    {session.idleSeconds >= 60 && <span className="admin-empty"> — nothing is fetching this</span>}
                  </td>
                </tr>
              ))}
              {health && health.transcode.active.length === 0 && (
                <tr>
                  <td colSpan={6} className="admin-empty">
                    None running
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {health && (
          <>
            {health.transcode.active.length > 0 && (
              <p className="setup-hint">
              Every live segment is relayed through this host, so the rates above are bandwidth the NAS
              is carrying for other people's players —{' '}
              {(() => {
                const total = health.transcode.active.reduce(
                  (sum, session) => sum + (session.bytesPerSecond ?? 0),
                  0
                )
                return `${mbpsFromBytesPerSecond(total)} across ${health.transcode.active.length} ${
                  health.transcode.active.length === 1 ? 'session' : 'sessions'
                } right now`
              })()}
              . If that number is below what a channel should produce, the host is the bottleneck — no
              amount of recovery in the player will change it.
            </p>
          )}
            <p className="setup-hint">
              Segments are written to <code>{health.transcode.storage.dir}</code>
              {health.transcode.storage.freeBytes !== null
                ? ` — ${formatBytesShort(health.transcode.storage.freeBytes)} free there.`
                : ' (free space unavailable).'}{' '}
              A movie keeps every segment while it plays, so a feature-length title can use several
              gigabytes; point <code>TRANSCODE_TMP_DIR</code> somewhere roomy if that is a problem.
            </p>
          </>
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

      <DecoderCheck />
    </div>
  )
}

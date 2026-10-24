import { useCallback, useEffect, useState, type CSSProperties, type JSX } from 'react'
import type { Session } from '../lib/appAuth'
import { useResizableColumns, type ColumnSpec } from '../lib/useResizableColumns'

const SOURCE_COLUMNS: ColumnSpec[] = [
  { key: 'source', label: 'Source', defaultWidth: 300, min: 160, max: 700 },
  { key: 'status', label: 'Status', defaultWidth: 100, min: 80, max: 300 },
  { key: 'downloaded', label: 'Downloaded', defaultWidth: 150, min: 100, max: 360 },
  { key: 'progress', label: 'Progress', defaultWidth: 100, min: 80, max: 300 },
  { key: 'channels', label: 'Guide channels', defaultWidth: 125, min: 90, max: 360 },
  { key: 'programmes', label: 'Programmes', defaultWidth: 125, min: 90, max: 360 },
  { key: 'matched', label: 'Channels matched', defaultWidth: 135, min: 90, max: 360 },
  { key: 'share', label: 'Share of matches', defaultWidth: 125, min: 90, max: 300 },
  { key: 'fetched', label: 'Last fetched', defaultWidth: 125, min: 100, max: 360 },
  { key: 'actions', label: '', defaultWidth: 110, min: 90, max: 260 }
]

// The EPG section: shows every guide the account uses (the provider's own guide plus any
// external XMLTV sources), their health, how much of the channel list they actually cover, and
// lets sources be added or removed. Adding/removing saves straight to the account (the provider
// credentials themselves are left untouched server-side).

interface EpgSourceStatus {
  kind: 'provider' | 'external'
  url: string
  status: 'ok' | 'error' | 'loading'
  channelCount: number
  programmeCount: number
  fetchedAt: number | null
  error?: string
  /** Download progress while loading — and where a failed download got to. */
  progress?: { receivedBytes: number; totalBytes: number | null } | null
}

interface MatchSummary {
  streams: number
  matched: number
  unmatched: number
  byStrategy: Record<string, number>
  /** How many channels each guide source answered for, most useful first. */
  bySource?: { url: string; matched: number }[]
  buildMs: number
  builtAt: number
}

interface BulkSuggestionRow {
  streamId: number
  channelName: string
  guideChannelId: string
  guideChannelName: string
  score: number
}

interface BulkSuggestResponse {
  ok?: boolean
  threshold?: number
  considered?: number
  alreadyMapped?: number
  belowThreshold?: number
  applied?: BulkSuggestionRow[]
  error?: string
}

/** The same ladder the desktop sibling's bulk apply offers — the operator's known shape. */
const BULK_THRESHOLDS = [0.6, 0.7, 0.8, 0.9, 1]
const BULK_PREVIEW_ROWS = 20

interface EpgConfigResponse {
  epgUrls: string[]
  sources: EpgSourceStatus[]
  summary: MatchSummary | null
  /** Whether this user may change the sources — they are a system setting, so admins only. */
  canEdit?: boolean
  updatedAt?: string | null
  updatedBy?: string | null
}

const MAX_EPG_URLS = 8
const POLL_ACTIVE_MS = 3000
const POLL_IDLE_MS = 15000

function formatCount(value: number): string {
  return value.toLocaleString()
}

function formatBytes(value: number): string {
  if (value >= 1_048_576) return `${(value / 1_048_576).toFixed(1)} MB`
  if (value >= 1024) return `${(value / 1024).toFixed(0)} KB`
  return `${value} B`
}

// Downloaded so far, against the size the server declared when it declares one. Persisted after
// the fetch ends too — a guide's size is worth seeing, and a FAILED download's last reading is
// the diagnosis (12 MB of 97 MB says the edge dropped it midway; 0 bytes says it never started).
function downloadedLabel(source: EpgSourceStatus): string {
  if (!source.progress || source.progress.receivedBytes === 0) return '—'
  const { receivedBytes, totalBytes } = source.progress
  return totalBytes ? `${formatBytes(receivedBytes)} / ${formatBytes(totalBytes)}` : formatBytes(receivedBytes)
}

// Percent while loading; '—' once settled (the size column carries the finished number) or when
// the server declared no length and a percentage would be invented.
function progressLabel(source: EpgSourceStatus): string {
  if (source.status !== 'loading' || !source.progress) return '—'
  const { receivedBytes, totalBytes } = source.progress
  if (!totalBytes) return receivedBytes > 0 ? 'unknown size' : '—'
  return `${Math.min(100, Math.round((receivedBytes / totalBytes) * 100))}%`
}

// '—' (matching hasn't run for this source yet) and 0 (matching ran; the source contributes
// nothing) mean different things — a source that silently answers for zero channels is exactly
// what these columns exist to expose.
function formatMatched(matched: number | undefined): string {
  return matched === undefined ? '—' : formatCount(matched)
}

function formatShare(matched: number | undefined, summary: MatchSummary | null): string {
  if (matched === undefined || !summary || summary.matched === 0) return '—'
  return `${Math.round((matched / summary.matched) * 100)}%`
}

function statusLabel(source: EpgSourceStatus): string {
  if (source.status === 'ok') return 'ready'
  if (source.status === 'loading') return 'loading'
  return 'error'
}

function shortUrl(url: string): string {
  return url.length > 68 ? `${url.slice(0, 65)}…` : url
}

import { sourceUrlWithoutCredentials } from '../lib/sourceLabel'
export function EpgSettings({ session }: { session: Session }): JSX.Element {
  const [config, setConfig] = useState<EpgConfigResponse | null>(null)
  const [newUrl, setNewUrl] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  // Bulk mapping suggestions (v0.82.0): threshold choice, the fetched preview, and the run's
  // outcome. The preview is fetched on demand (the plan walks every channel); the apply re-plans
  // server-side, so what lands is what scores at apply time, not what the preview showed.
  const [bulkThreshold, setBulkThreshold] = useState(0.8)
  const [bulkPreview, setBulkPreview] = useState<BulkSuggestResponse | null>(null)
  const [bulkBusy, setBulkBusy] = useState(false)
  const [bulkResult, setBulkResult] = useState<string | null>(null)
  const [bulkError, setBulkError] = useState<string | null>(null)

  const suggestQuery = (threshold: number): string =>
    `?playlist=&threshold=${threshold}`

  async function handleBulkSuggest(): Promise<void> {
    setBulkBusy(true)
    setBulkError(null)
    setBulkResult(null)
    try {
      const res = await fetch(`/api/epg/mappings/bulk-suggest${suggestQuery(bulkThreshold)}`)
      const data = (await res.json().catch(() => ({}))) as BulkSuggestResponse
      if (!res.ok) throw new Error(data.error ?? 'Could not plan bulk suggestions')
      setBulkPreview(data)
    } catch (err) {
      setBulkError(err instanceof Error ? err.message : 'Could not plan bulk suggestions')
      setBulkPreview(null)
    } finally {
      setBulkBusy(false)
    }
  }

  async function handleBulkApply(): Promise<void> {
    setBulkBusy(true)
    setBulkError(null)
    try {
      const res = await fetch('/api/epg/mappings/bulk-apply?playlist=', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ threshold: bulkThreshold })
      })
      const data = (await res.json().catch(() => ({}))) as BulkSuggestResponse & { applied?: number }
      if (!res.ok) throw new Error(data.error ?? 'Could not apply bulk suggestions')
      setBulkResult(
        (data.applied ?? 0) > 0
          ? `Applied ${data.applied} mapping(s) — every one is an ordinary manual mapping now, reviewable and clearable per channel in the guide.`
          : `Nothing to apply at ${Math.round(bulkThreshold * 100)}% — try a lower threshold.`
      )
      setBulkPreview(null)
      await refresh()
    } catch (err) {
      setBulkError(err instanceof Error ? err.message : 'Could not apply bulk suggestions')
    } finally {
      setBulkBusy(false)
    }
  }

  const sourceCols = useResizableColumns('epg-sources', SOURCE_COLUMNS)

  const refresh = useCallback(async (): Promise<boolean> => {
    try {
      const res = await fetch('/api/epg/config')
      if (res.status === 401) {
        window.location.reload()
        return false
      }
      const data = (await res.json().catch(() => ({}))) as Partial<EpgConfigResponse> & { error?: string }
      if (!res.ok) throw new Error(data.error ?? 'Could not load the EPG configuration')
      setConfig({
        epgUrls: data.epgUrls ?? [],
        sources: data.sources ?? [],
        summary: data.summary ?? null,
        canEdit: data.canEdit === true,
        updatedAt: data.updatedAt ?? null,
        updatedBy: data.updatedBy ?? null
      })
      setError(null)
      return (data.sources ?? []).some((source) => source.status === 'loading')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load the EPG configuration')
      return false
    }
  }, [])

  // Poll faster while sources are downloading (a provider guide can take a minute), slowly once
  // everything is settled.
  useEffect(() => {
    let timer: number | null = null
    let cancelled = false
    const tick = async (): Promise<void> => {
      const loading = await refresh()
      if (cancelled) return
      timer = window.setTimeout(() => void tick(), loading ? POLL_ACTIVE_MS : POLL_IDLE_MS)
    }
    void tick()
    return () => {
      cancelled = true
      if (timer !== null) window.clearTimeout(timer)
    }
  }, [refresh])

  async function saveSources(epgUrls: string[]): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/epg/sources', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ epgUrls })
      })
      const data = (await res.json().catch(() => ({}))) as { error?: string }
      if (!res.ok) throw new Error(data.error ?? 'Could not save the EPG sources')
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the EPG sources')
    } finally {
      setBusy(false)
    }
  }

  async function handleAdd(e: React.FormEvent): Promise<void> {
    e.preventDefault()
    const url = newUrl.trim()
    if (!url) return
    if (!/^https?:\/\//i.test(url)) {
      setError('The EPG URL must start with http:// or https://')
      return
    }
    const existing = config?.epgUrls ?? []
    if (existing.includes(url)) {
      setError('That EPG URL is already configured')
      return
    }
    if (existing.length >= MAX_EPG_URLS) {
      setError(`At most ${MAX_EPG_URLS} external EPG sources can be configured`)
      return
    }
    setNote(`Adding ${url} — the guide is downloading in the background.`)
    await saveSources([...existing, url])
    setNewUrl('')
  }

  async function handleRemove(url: string): Promise<void> {
    const existing = config?.epgUrls ?? []
    setNote(null)
    await saveSources(existing.filter((entry) => entry !== url))
  }

  // One source when a URL is given, every source otherwise. A per-source refresh is the whole
  // point: retrying one small feed must not drag the provider's 168 MB guide down with it.
  async function handleRefreshGuides(url?: string): Promise<void> {
    setBusy(true)
    setNote(url ? `Refreshing ${shortUrl(url)}…` : 'Refreshing guides…')
    try {
      const res = await fetch('/api/epg/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: url ?? null })
      })
      const data = (await res.json().catch(() => ({}))) as { error?: string }
      if (!res.ok) throw new Error(data.error ?? 'Could not refresh the guides')
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not refresh the guides')
    } finally {
      setBusy(false)
    }
  }

  const sources = config?.sources ?? []
  const canEdit = config?.canEdit === true
  const provider = sources.find((source) => source.kind === 'provider')
  const externals = sources.filter((source) => source.kind === 'external')
  const summary = config?.summary ?? null
  const coverage = summary && summary.streams > 0 ? Math.round((summary.matched / summary.streams) * 100) : null
  // Which guide each match came from, shown inline in the sources table: a source that
  // contributes nothing — or everything — is visible on its own row without a second screen.
  const matchedBySource = new Map((summary?.bySource ?? []).map((entry) => [entry.url, entry.matched]))

  return (
    <div className="admin-console">
      {error && <div className="login-error admin-error">{error}</div>}
      {note && <div className="epg-note">{note}</div>}

      <section className="admin-section">
        <h2>Guide coverage</h2>
        {summary ? (
          <div className="epg-stats">
            <div className="epg-stat">
              <span className="epg-stat-value">{coverage}%</span>
              <span className="epg-stat-label">of channels have guide data</span>
            </div>
            <div className="epg-stat">
              <span className="epg-stat-value">
                {formatCount(summary.matched)} / {formatCount(summary.streams)}
              </span>
              <span className="epg-stat-label">channels matched</span>
            </div>
            <div className="epg-stat">
              <span className="epg-stat-value">{formatCount(summary.byStrategy['fuzzy-name'] ?? 0)}</span>
              <span className="epg-stat-label">matched fuzzily (name similarity)</span>
            </div>
            <div className="epg-stat">
              <span className="epg-stat-value">
                {formatCount(
                  (summary.byStrategy['exact-id'] ?? 0) +
                    (summary.byStrategy['normalized-id'] ?? 0) +
                    (summary.byStrategy['exact-name'] ?? 0)
                )}
              </span>
              <span className="epg-stat-label">matched exactly</span>
            </div>
          </div>
        ) : (
          <p className="setup-hint">Matching is running — open Live TV once and this fills in.</p>
        )}

        {canEdit && (summary?.unmatched ?? 0) > 0 && (
          <div className="bulk-suggest">
            <div className="epg-section-actions" style={{ marginTop: 10 }}>
              <label className="setup-hint" style={{ marginRight: 4 }}>
                Auto-map unmatched channels scoring at{' '}
                <select
                  value={bulkThreshold}
                  onChange={(e) => {
                    setBulkThreshold(Number(e.target.value))
                    setBulkPreview(null)
                    setBulkResult(null)
                  }}
                  disabled={bulkBusy}
                >
                  {BULK_THRESHOLDS.map((value) => (
                    <option key={value} value={value}>
                      {Math.round(value * 100)}%
                    </option>
                  ))}
                </select>{' '}
                or better
              </label>
              <button type="button" className="admin-small-btn" onClick={() => void handleBulkSuggest()} disabled={bulkBusy}>
                {bulkBusy ? 'Scoring…' : 'Suggest mappings'}
              </button>
            </div>
            {bulkError && <div className="login-error" style={{ marginTop: 8 }}>{bulkError}</div>}
            {bulkResult && <p className="epg-note" style={{ marginTop: 8 }}>{bulkResult}</p>}
            {bulkPreview && (
              <div style={{ marginTop: 8 }}>
                <p className="epg-note">
                  {bulkPreview.considered === 0
                    ? 'Every channel already resolves to live guide data — nothing to suggest.'
                    : `${bulkPreview.considered} channel(s) have no live guide data; ${bulkPreview.applied?.length ?? 0} scored ${Math.round(
                        (bulkPreview.threshold ?? bulkThreshold) * 100
                      )}% or better, ${bulkPreview.belowThreshold ?? 0} did not. ${bulkPreview.alreadyMapped ?? 0} of your own mappings are left untouched.`}
                </p>
                {(bulkPreview.applied?.length ?? 0) > 0 && (
                  <>
                    <div className="admin-table-wrap" style={{ maxHeight: 260 }}>
                      <table className="admin-table">
                        <thead>
                          <tr>
                            <th>Channel</th>
                            <th>Suggested guide channel</th>
                            <th>Score</th>
                          </tr>
                        </thead>
                        <tbody>
                          {(bulkPreview.applied ?? []).slice(0, BULK_PREVIEW_ROWS).map((row) => (
                            <tr key={row.streamId}>
                              <td>{row.channelName}</td>
                              <td>{row.guideChannelName}</td>
                              <td>{Math.round(row.score * 100)}%</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    {(bulkPreview.applied?.length ?? 0) > BULK_PREVIEW_ROWS && (
                      <p className="setup-hint">
                        Showing the first {BULK_PREVIEW_ROWS} of {bulkPreview.applied?.length}.
                      </p>
                    )}
                    <button type="button" className="admin-small-btn" onClick={() => void handleBulkApply()} disabled={bulkBusy}>
                      {bulkBusy ? 'Applying…' : `Apply ${bulkPreview.applied?.length} mapping(s)`}
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        )}
      </section>

      <section className="admin-section">
        <div className="epg-section-head">
          <h2>Guide sources</h2>
          <div className="epg-section-actions">
            <button type="button" className="admin-small-btn" onClick={() => sourceCols.reset()}>
              Reset columns
            </button>
            {canEdit && (
              <button type="button" className="admin-small-btn" onClick={() => void handleRefreshGuides()} disabled={busy}>
                Refresh all guides
              </button>
            )}
          </div>
        </div>
        <p className="setup-hint">
          Guide sources are a <strong>system-wide setting</strong> — one set for everyone, kept in the
          database and refreshed <strong>once a day</strong>. A restart reuses the last download instead
          of fetching again.{' '}
          {canEdit ? 'Add, remove or refresh them here.' : 'Only an admin can change them.'}
          {config?.updatedBy
            ? ` Last changed by ${config.updatedBy}${config.updatedAt ? ` on ${new Date(config.updatedAt).toLocaleDateString()}` : ''}.`
            : ''}
        </p>
        <div className="admin-table-wrap">
          <table
            className="admin-table admin-table--fixed"
            style={{ '--table-font-scale': sourceCols.fontScale } as CSSProperties}
          >
            <thead>
              <tr>
                {SOURCE_COLUMNS.map((column) => (
                  <th key={column.key} style={{ width: `${sourceCols.percent[column.key]}%` }}>
                    {column.label}
                    <span
                      className="col-resize"
                      onPointerDown={sourceCols.startDrag(column.key)}
                      onDoubleClick={() => sourceCols.reset(column.key)}
                      title="Drag to resize · double-click to reset"
                    />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sources.length === 0 && (
                <tr>
                  <td colSpan={10} className="admin-empty">No guide sources yet</td>
                </tr>
              )}
              {provider && (
                <tr>
                  <td>
                    <span className="epg-source-name">Provider guide</span>
                    {/* No query: it carries the account credentials. */}
                    <span className="epg-source-url" title="The provider's own guide">
                      {sourceUrlWithoutCredentials(provider.url)}
                    </span>
                    {/* The provider guide's error was previously invisible — the status cell said
                        "error" and the message appeared nowhere, so a failing guide could not be
                        diagnosed from the screen that shows it. */}
                    {provider.error && <span className="epg-source-url">{provider.error}</span>}
                  </td>
                  <td>
                    <span
                      className={`epg-status epg-status-${provider.status}`}
                      title={provider.error ?? undefined}
                    >
                      {statusLabel(provider)}
                    </span>
                  </td>
                  <td>{downloadedLabel(provider)}</td>
                  <td>{progressLabel(provider)}</td>
                  <td>{formatCount(provider.channelCount)}</td>
                  <td>{formatCount(provider.programmeCount)}</td>
                  <td>{formatMatched(matchedBySource.get(provider.url))}</td>
                  <td>{formatShare(matchedBySource.get(provider.url), summary)}</td>
                  <td>{provider.fetchedAt ? new Date(provider.fetchedAt).toLocaleTimeString() : '—'}</td>
                  <td>
                    {canEdit ? (
                      <button
                        type="button"
                        className="admin-small-btn"
                        onClick={() => void handleRefreshGuides(provider.url)}
                        disabled={busy}
                        title="Re-download just this guide"
                      >
                        Refresh
                      </button>
                    ) : (
                      <span className="admin-muted">built in</span>
                    )}
                  </td>
                </tr>
              )}
              {externals.map((source) => (
                <tr key={source.url}>
                  <td>
                    <span className="epg-source-name">External XMLTV</span>
                    {/* In full. Truncating it in code meant a wider column could never reveal the rest. */}
                    <span className="epg-source-url" title={source.url}>{source.url}</span>
                  </td>
                  <td>
                    <span
                      className={`epg-status epg-status-${source.status}`}
                      title={source.error ?? undefined}
                    >
                      {statusLabel(source)}
                    </span>
                  </td>
                  <td>{downloadedLabel(source)}</td>
                  <td>{progressLabel(source)}</td>
                  <td>{formatCount(source.channelCount)}</td>
                  <td>{formatCount(source.programmeCount)}</td>
                  <td>{formatMatched(matchedBySource.get(source.url))}</td>
                  <td>{formatShare(matchedBySource.get(source.url), summary)}</td>
                  <td>{source.fetchedAt ? new Date(source.fetchedAt).toLocaleTimeString() : '—'}</td>
                  <td>
                    {canEdit ? (
                      <>
                        <button
                          type="button"
                          className="admin-small-btn"
                          onClick={() => void handleRefreshGuides(source.url)}
                          disabled={busy}
                          title="Re-download just this guide"
                        >
                          Refresh
                        </button>{' '}
                        <button type="button" className="admin-small-btn danger" onClick={() => void handleRemove(source.url)} disabled={busy}>
                          Remove
                        </button>
                      </>
                    ) : (
                      <span className="admin-muted">admin only</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {(externals.some((source) => source.error) || provider?.error) && (
          <p className="setup-hint">
            {sources
              .filter((source) => source.error)
              .map((source) => `${source.kind === 'provider' ? 'Provider guide' : shortUrl(source.url)}: ${source.error}`)
              .join(' · ')}
          </p>
        )}

        {canEdit && (
        <form className="add-user-form" onSubmit={(e) => void handleAdd(e)}>
          <h3>Add an external EPG source</h3>
          <div className="add-user-row">
            <label>
              XMLTV URL
              <input
                value={newUrl}
                onChange={(e) => setNewUrl(e.target.value)}
                placeholder="https://example.com/guide.xml"
                style={{ width: 420 }}
              />
            </label>
            <button type="submit" disabled={busy}>
              {busy ? 'Saving…' : 'Add source'}
            </button>
          </div>
          <p className="setup-hint" style={{ marginTop: 10 }}>
            Up to {MAX_EPG_URLS} sources. Channels your provider's guide has nothing for are filled from
            these, in order. Existing channels always keep the provider's own data.
          </p>
        </form>
        )}
      </section>
    </div>
  )
}

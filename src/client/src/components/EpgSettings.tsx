import { useCallback, useEffect, useState, type JSX } from 'react'
import type { Session } from '../lib/appAuth'

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
}

interface MatchSummary {
  streams: number
  matched: number
  unmatched: number
  byStrategy: Record<string, number>
  buildMs: number
  builtAt: number
}

interface EpgConfigResponse {
  epgUrls: string[]
  sources: EpgSourceStatus[]
  summary: MatchSummary | null
}

const MAX_EPG_URLS = 8
const POLL_ACTIVE_MS = 3000
const POLL_IDLE_MS = 15000

function formatCount(value: number): string {
  return value.toLocaleString()
}

function statusLabel(source: EpgSourceStatus): string {
  if (source.status === 'ok') return 'ready'
  if (source.status === 'loading') return 'loading'
  return 'error'
}

function shortUrl(url: string): string {
  return url.length > 68 ? `${url.slice(0, 65)}…` : url
}

export function EpgSettings({ session }: { session: Session }): JSX.Element {
  const [config, setConfig] = useState<EpgConfigResponse | null>(null)
  const [newUrl, setNewUrl] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)

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
        summary: data.summary ?? null
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

  async function handleRefreshGuides(): Promise<void> {
    setBusy(true)
    setNote('Refreshing guides…')
    try {
      const res = await fetch('/api/epg/refresh', { method: 'POST' })
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
  const provider = sources.find((source) => source.kind === 'provider')
  const externals = sources.filter((source) => source.kind === 'external')
  const summary = config?.summary ?? null
  const coverage = summary && summary.streams > 0 ? Math.round((summary.matched / summary.streams) * 100) : null

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
      </section>

      <section className="admin-section">
        <div className="epg-section-head">
          <h2>Guide sources</h2>
          <button type="button" className="admin-small-btn" onClick={() => void handleRefreshGuides()} disabled={busy}>
            Refresh guides
          </button>
        </div>
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Source</th>
                <th>Status</th>
                <th>Guide channels</th>
                <th>Programmes</th>
                <th>Last fetched</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {sources.length === 0 && (
                <tr>
                  <td colSpan={6} className="admin-empty">No guide sources yet</td>
                </tr>
              )}
              {provider && (
                <tr>
                  <td>
                    <span className="epg-source-name">Provider guide</span>
                    <span className="epg-source-url">{shortUrl(provider.url)}</span>
                  </td>
                  <td><span className={`epg-status epg-status-${provider.status}`}>{statusLabel(provider)}</span></td>
                  <td>{formatCount(provider.channelCount)}</td>
                  <td>{formatCount(provider.programmeCount)}</td>
                  <td>{provider.fetchedAt ? new Date(provider.fetchedAt).toLocaleTimeString() : '—'}</td>
                  <td><span className="admin-muted">built in</span></td>
                </tr>
              )}
              {externals.map((source) => (
                <tr key={source.url}>
                  <td>
                    <span className="epg-source-name">External XMLTV</span>
                    <span className="epg-source-url">{shortUrl(source.url)}</span>
                  </td>
                  <td><span className={`epg-status epg-status-${source.status}`}>{statusLabel(source)}</span></td>
                  <td>{formatCount(source.channelCount)}</td>
                  <td>{formatCount(source.programmeCount)}</td>
                  <td>{source.fetchedAt ? new Date(source.fetchedAt).toLocaleTimeString() : '—'}</td>
                  <td>
                    <button type="button" className="admin-small-btn danger" onClick={() => void handleRemove(source.url)} disabled={busy}>
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {externals.some((source) => source.error) && (
          <p className="setup-hint">
            {externals
              .filter((source) => source.error)
              .map((source) => `${shortUrl(source.url)}: ${source.error}`)
              .join(' · ')}
          </p>
        )}

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
      </section>
    </div>
  )
}

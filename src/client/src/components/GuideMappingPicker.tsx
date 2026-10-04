import { useEffect, useMemo, useState, type CSSProperties, type JSX } from 'react'
import type { Session } from '../lib/appAuth'

// The manual channel→guide mapping picker (v0.76.0) — the operator's override for a channel
// the conservative matcher cannot resolve. One request loads everything it needs
// (/api/epg/mappings/:streamId): what the matcher already decided, the manual override if any,
// the top fuzzy suggestions, and the full guide-channel list for searching. Setting/clearing is
// one POST/DELETE; the parent reloads the grid.

interface PickerData {
  streamName: string
  automatic: { channelId: string; strategy: string; score?: number } | null
  manual: { guideChannelId: string; guideChannelName: string; setAt: number } | null
  suggestions: Array<{ guideChannelId: string; guideChannelName: string; score: number }>
  guideChannels: Array<{ id: string; name: string }>
  mappingsInUse: number
}

const STRATEGY_TEXT: Record<string, string> = {
  'exact-id': 'matched by exact guide id',
  'normalized-id': 'matched by normalized guide id',
  'exact-name': 'matched by channel name',
  'fuzzy-name': 'matched by name similarity',
  manual: 'manually mapped'
}

export function GuideMappingPicker({
  session,
  streamId,
  onClose,
  onMappingChanged
}: {
  session: Session
  streamId: number
  onClose: () => void
  onMappingChanged: () => void
}): JSX.Element {
  const [data, setData] = useState<PickerData | null>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let active = true
    setStatus('loading')
    fetch(`/api/epg/mappings/${streamId}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return (await res.json()) as PickerData & { ok: true }
      })
      .then((next) => {
        if (!active) return
        setData(next)
        setStatus('ready')
      })
      .catch((err) => {
        if (!active) return
        setError(err instanceof Error ? err.message : String(err))
        setStatus('error')
      })
    return () => {
      active = false
    }
  }, [streamId])

  async function apply(guideChannelId: string, guideChannelName: string): Promise<void> {
    setSaving(true)
    setError(null)
    try {
      const res = await fetch(`/api/epg/mappings/${streamId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ guideChannelId, guideChannelName, channelName: data?.streamName })
      })
      if (!res.ok) throw new Error((await res.text()) || `HTTP ${res.status}`)
      onMappingChanged()
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  async function clearMapping(): Promise<void> {
    setSaving(true)
    setError(null)
    try {
      const res = await fetch(`/api/epg/mappings/${streamId}`, { method: 'DELETE' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      onMappingChanged()
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const filtered = useMemo(() => {
    if (!data) return []
    const q = query.trim().toLowerCase()
    const list = q.length === 0 ? data.guideChannels : data.guideChannels.filter((c) => c.name.toLowerCase().includes(q) || c.id.toLowerCase().includes(q))
    return list.slice(0, 200)
  }, [data, query])

  return (
    <div style={overlayStyle} onClick={onClose}>
      <div style={panelStyle} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12 }}>
          <strong>Map to guide</strong>
          <button type="button" className="admin-small-btn" onClick={onClose}>
            Close
          </button>
        </div>
        <p className="setup-hint" style={{ margin: '4px 0 8px' }}>
          {data?.streamName ?? `Channel #${streamId}`} — pin this channel to one guide entry. A manual mapping wins over
          every automatic match; Clear hands the decision back to the matcher.
        </p>
        {status === 'loading' && <p className="setup-hint">Loading…</p>}
        {status === 'error' && <div className="login-error">{error ?? 'Could not load the mapping picker'}</div>}
        {data && status === 'ready' && (
          <>
            {data.manual && (
              <p className="setup-hint" style={{ margin: '0 0 6px' }}>
                Manually mapped to <strong>{data.manual.guideChannelName}</strong> ({data.manual.guideChannelId}).
              </p>
            )}
            {!data.manual && data.automatic && (
              <p className="setup-hint" style={{ margin: '0 0 6px' }}>
                The matcher already maps this channel to <strong>{STRATEGY_TEXT[data.automatic.strategy] ?? data.automatic.strategy}</strong>
                {data.automatic.strategy === 'fuzzy-name' ? ` (${Math.round((data.automatic.score ?? 0) * 100)}%)` : ''}:{' '}
                {data.automatic.channelId}
              </p>
            )}
            {!data.manual && !data.automatic && (
              <p className="setup-hint" style={{ margin: '0 0 6px' }}>
                The matcher found nothing for this channel — that is why it shows no programmes. Suggestions below, or search.
              </p>
            )}
            {data.suggestions.length > 0 && !data.manual && (
              <div style={{ margin: '6px 0' }}>
                <div className="setup-hint" style={{ marginBottom: 4 }}>Suggestions:</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {data.suggestions.map((s) => (
                    <button
                      key={s.guideChannelId}
                      type="button"
                      className="admin-small-btn"
                      disabled={saving}
                      onClick={() => void apply(s.guideChannelId, s.guideChannelName)}
                    >
                      {s.guideChannelName} ({Math.round(s.score * 100)}%)
                    </button>
                  ))}
                </div>
              </div>
            )}
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search the guide's channels…"
              style={{ width: '100%', margin: '8px 0' }}
            />
            <div style={{ maxHeight: 260, overflowY: 'auto', border: '1px solid rgba(255,255,255,0.15)', borderRadius: 6 }}>
              {filtered.length === 0 && <div className="setup-hint" style={{ padding: 8 }}>No guide channel matches that search.</div>}
              {filtered.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  disabled={saving}
                  onClick={() => void apply(c.id, c.name)}
                  style={{ display: 'block', width: '100%', textAlign: 'left', padding: '6px 10px', background: 'none', border: 'none', color: 'inherit', cursor: 'pointer' }}
                  title={c.id}
                >
                  {c.name}
                </button>
              ))}
            </div>
            <div style={{ marginTop: 10, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
              <span className="setup-hint">{data.mappingsInUse} manual mapping(s) saved.</span>
              {data.manual && (
                <button type="button" className="admin-small-btn" disabled={saving} onClick={() => void clearMapping()}>
                  Clear mapping
                </button>
              )}
            </div>
          </>
        )}
        {error && status !== 'error' && <div className="login-error">{error}</div>}
      </div>
    </div>
  )
}

const overlayStyle: CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0,0,0,0.6)',
  zIndex: 200,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center'
}

const panelStyle: CSSProperties = {
  background: 'var(--bg, #14181d)',
  color: 'inherit',
  borderRadius: 10,
  padding: 16,
  width: 'min(560px, 92vw)',
  maxHeight: '80vh',
  overflowY: 'auto',
  boxShadow: '0 12px 40px rgba(0,0,0,0.5)'
}

import { useCallback, useEffect, useState, type JSX } from 'react'
import {
  fetchSportsConfig,
  fetchSportsKey,
  saveSportsKey,
  type FixtureCacheInfo,
  type SportFeed
} from '../lib/sportsFixtures'

// Admin → Sports data: the api-football.com key behind the Sports tab's fixtures and live scores.
//
// Like the guide sources it is a **system-wide setting** — one key for the household, stored
// encrypted at rest, written only by an admin, and spent only by the server.
//
// The field *shows* the key and lets it be changed, which the operator asked for (2026-09-28). That
// is a deliberate exception to the rule the provider credentials follow (never returned at all,
// v0.11.0): this one is a lesser secret, and the alternative — a field that says "a key is set" and
// nothing else — made it impossible to check what was actually configured. It reaches nobody who is
// not an admin, and it is never logged.

export function SportsPanel(): JSX.Element {
  const [stored, setStored] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [provenance, setProvenance] = useState<{ updatedAt: string | null; updatedBy: string | null }>({
    updatedAt: null,
    updatedBy: null
  })
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // What the key reaches and what it costs — the admin screen's window onto the catalogue and the
  // quota, so "only football calls are being made" is answerable from the screen itself.
  const [feeds, setFeeds] = useState<SportFeed[] | null>(null)
  const [budget, setBudget] = useState<{ remaining: number; used: number } | null>(null)
  const [cache, setCache] = useState<FixtureCacheInfo | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const config = await fetchSportsConfig()
      setFeeds(config.sports ?? null)
      setBudget(config.budget ?? null)
      setCache(config.cache ?? null)
      const info = config.keySet
        ? await fetchSportsKey()
        : { key: null, updatedAt: null, updatedBy: null }
      setStored(info.key)
      setDraft(info.key ?? '')
      setProvenance({ updatedAt: info.updatedAt, updatedBy: info.updatedBy })
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not read the sports settings')
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const save = async (key: string | null): Promise<void> => {
    setBusy(true)
    setNote(null)
    setError(null)
    try {
      await saveSportsKey(key)
      await refresh()
      setNote(
        key === null
          ? 'Key cleared — the Sports tab keeps its schedule and drops the fixtures and scores.'
          : 'Key saved. Reload the Sports tab to pick it up.'
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the key')
    } finally {
      setBusy(false)
    }
  }

  const dirty = draft.trim() !== (stored ?? '')

  return (
    <section className="admin-section">
      <div className="epg-section-head">
        <h2>Sports data</h2>
      </div>
      <p className="setup-hint">
        An{' '}
        <a href="https://www.api-football.com/" target="_blank" rel="noopener noreferrer">
          api-football.com
        </a>{' '}
        key gives the Sports tab its fixtures and live scores. Like the guide sources it is a{' '}
        <strong>system-wide setting</strong> — one key for everyone — stored encrypted on the server
        and spent only there. Only an admin can see or change it.
      </p>
      {error && <div className="login-error admin-error">{error}</div>}
      <div className="epg-preset-row">
        <label htmlFor="sports-key">API key</label>
        <input
          id="sports-key"
          className="sports-key-input"
          type="text"
          value={draft}
          placeholder="x-apisports-key"
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => setDraft(e.target.value)}
        />
        <button
          type="button"
          className="admin-small-btn"
          onClick={() => void save(draft.trim())}
          disabled={busy || !dirty || draft.trim().length === 0}
        >
          {busy ? 'Saving…' : stored ? 'Save change' : 'Save'}
        </button>
        {stored && (
          <button type="button" className="admin-small-btn danger" onClick={() => void save(null)} disabled={busy}>
            Clear
          </button>
        )}
      </div>
      <p className="setup-hint">
        {stored
          ? `A key is set${provenance.updatedBy ? ` (${provenance.updatedBy}${provenance.updatedAt ? `, ${new Date(provenance.updatedAt).toLocaleString()}` : ''})` : ''} — the Sports tab is using it. Clear it to fall back to the provider's own schedule.`
          : 'No key is set, so the Sports tab shows the provider’s own schedule, without fixtures or scores.'}{' '}
        A key can also be supplied out of band with <code>SPORTS_API_KEY</code> or a file at{' '}
        <code>/appdata/api-football.txt</code>; one saved here takes precedence over a file.
      </p>
      {feeds && feeds.length > 0 && (
        <p className="setup-hint">
          The catalogue this key is asked for ({feeds.length} feeds, one request each per day):{' '}
          {feeds.map((feed) => feed.label).join(' · ')}. NBA lives inside the basketball feed — the
          app does not query it twice.
          {budget && ` Requests today: ${budget.used} of 80 (the app's own ceiling under the plan's 100).`}
          {cache &&
            cache.days > 0 &&
            ` Stored answers: ${cache.days} day${cache.days === 1 ? '' : 's'}${
              cache.oldest ? `, ${cache.oldest} to ${cache.newest}` : ''
            } — kept 7 days in the database, then purged.`}
        </p>
      )}
      {note && <p className="setup-hint">{note}</p>}
    </section>
  )
}

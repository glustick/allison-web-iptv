import { useCallback, useEffect, useState, type JSX } from 'react'
import { fetchSportsConfig, saveSportsKey } from '../lib/sportsFixtures'

// Admin → Sports data: the api-football.com key behind the Sports tab's fixtures and live scores.
//
// The key is a credential, so it is stored server-side encrypted with the account's other
// credentials and is **never returned** — this screen only ever learns whether one is set. The
// server makes every request, the same rule the provider credentials have followed since v0.11.0.

export function SportsPanel(): JSX.Element {
  const [keySet, setKeySet] = useState<boolean | null>(null)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const { keySet: present } = await fetchSportsConfig()
      setKeySet(present)
    } catch (err) {
      setNote(err instanceof Error ? err.message : 'Could not read the sports settings')
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const save = async (key: string | null): Promise<void> => {
    setBusy(true)
    setNote(null)
    try {
      const { keySet: present } = await saveSportsKey(key)
      setKeySet(present)
      setDraft('')
      setNote(
        key === null
          ? 'Key cleared — the Sports tab keeps its schedule and drops the scores.'
          : 'Key saved. Reload the Sports tab to pick it up.'
      )
    } catch (err) {
      setNote(err instanceof Error ? err.message : 'Could not save the key')
    } finally {
      setBusy(false)
    }
  }

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
        key gives the Sports tab its fixtures and live scores. Like the guide sources, it is a{' '}
        <strong>system-wide setting</strong>: one key for everyone, stored encrypted on the server
        and never sent to the browser — the server makes every request.{' '}
        {keySet === null
          ? 'Checking…'
          : keySet
            ? 'A key is set.'
            : 'No key is set, so the tab shows the provider’s own schedule without scores.'}
      </p>
      <div className="epg-preset-row">
        <label htmlFor="sports-key">{keySet ? 'Replace key' : 'API key'}</label>
        <input
          id="sports-key"
          className="sports-key-input"
          type="password"
          value={draft}
          placeholder={keySet ? '•••••• (already set)' : 'x-apisports-key'}
          autoComplete="off"
          onChange={(e) => setDraft(e.target.value)}
        />
        <button
          type="button"
          className="admin-small-btn"
          onClick={() => void save(draft.trim())}
          disabled={busy || draft.trim().length === 0}
        >
          {busy ? 'Saving…' : 'Save'}
        </button>
        {keySet && (
          <button type="button" className="admin-small-btn danger" onClick={() => void save(null)} disabled={busy}>
            Clear
          </button>
        )}
      </div>
      {note && <p className="setup-hint">{note}</p>}
    </section>
  )
}

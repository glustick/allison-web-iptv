import { useEffect, useRef, useState, type JSX } from 'react'
import { search, type SearchHit, type SearchStatus } from '../lib/system'

// Global search over the provider's whole catalogue. Results are served from the SQLite index, so
// this keeps working when the provider itself is slow — but an unbuilt index shows its state
// rather than an empty list that looks like "no results".

const DEBOUNCE_MS = 250

export function SearchBar({ onPlay }: { onPlay: (hit: SearchHit) => void }): JSX.Element {
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<SearchHit[]>([])
  const [index, setIndex] = useState<SearchStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [searching, setSearching] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const trimmed = query.trim()
    if (trimmed.length < 2) {
      setHits([])
      setSearching(false)
      return
    }
    setSearching(true)
    const timer = window.setTimeout(() => {
      search(trimmed)
        .then((data) => {
          setHits(data.hits)
          setIndex(data.index)
          setError(null)
          setOpen(true)
        })
        .catch((err) => setError(err instanceof Error ? err.message : 'Search failed'))
        .finally(() => setSearching(false))
    }, DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [query])

  // Click-away closes the panel; the field keeps its text so a search isn't lost by a stray click.
  useEffect(() => {
    function onDown(event: MouseEvent): void {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [])

  const indexReady = (index?.total ?? 0) > 0

  return (
    <div className="search-bar" ref={containerRef}>
      <input
        type="search"
        className="search-input"
        placeholder="Search channels, films and series…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && hits[0]) {
            onPlay(hits[0])
            setOpen(false)
          }
          if (e.key === 'Escape') setOpen(false)
        }}
        aria-label="Search channels, films and series"
      />
      {open && query.trim().length >= 2 && (
        <div className="search-results">
          {error && <div className="search-note error">{error}</div>}
          {!error && index?.indexing && !indexReady && <div className="search-note">Building the search index…</div>}
          {!error && !index?.indexing && !indexReady && (
            <div className="search-note">
              No index yet — an admin can build it from the System tab (it needs the provider to be up).
            </div>
          )}
          {!error && indexReady && hits.length === 0 && !searching && <div className="search-note">No matches.</div>}
          {hits.map((hit) => (
            <button
              key={`${hit.kind}:${hit.streamId}`}
              type="button"
              className="search-hit"
              onClick={() => {
                onPlay(hit)
                setOpen(false)
              }}
            >
              {hit.icon ? <img className="reorder-icon" src={hit.icon} alt="" loading="lazy" /> : <span className="reorder-icon placeholder" />}
              <span className="reorder-label">{hit.name}</span>
              {hit.category && <span className="admin-muted">{hit.category}</span>}
              <span className={`kind-tag kind-${hit.kind}`}>{hit.kind}</span>
            </button>
          ))}
          {indexReady && (
            <div className="search-foot">
              {index?.total.toLocaleString()} items indexed
              {index?.indexedAt ? ` · ${new Date(index.indexedAt).toLocaleString()}` : ''}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

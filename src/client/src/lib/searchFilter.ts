/**
 * Which kind of result the viewer is looking at (v0.93.0).
 *
 * The search index returns channels, films and series in one list because the *question* is
 * "where is it", not "which shelf is it on". But once the list is long, narrowing it to one kind is
 * the fastest way to the answer — so the bar offers All / Live / Films / Series, and this is the
 * filter, kept pure so the counts and the list can never disagree.
 */
export type SearchFilter = 'all' | 'live' | 'movie' | 'series'

export const SEARCH_FILTERS: ReadonlyArray<{ id: SearchFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'live', label: 'Live' },
  { id: 'movie', label: 'Films' },
  { id: 'series', label: 'Series' }
]

export function filterHits<T extends { kind: string }>(hits: T[], filter: SearchFilter): T[] {
  if (filter === 'all') return hits
  return hits.filter((hit) => hit.kind === filter)
}

/** Per-filter counts for the chips, so an empty filter says 0 rather than looking broken. */
export function countHits<T extends { kind: string }>(hits: T[]): Record<SearchFilter, number> {
  return {
    all: hits.length,
    live: hits.filter((hit) => hit.kind === 'live').length,
    movie: hits.filter((hit) => hit.kind === 'movie').length,
    series: hits.filter((hit) => hit.kind === 'series').length
  }
}

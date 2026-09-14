import { createSearchStore, type SearchHit, type SearchIndexStats } from './searchStore.js'
import { createProviderLists, type ProviderCredentials } from './providerLists.js'
import type { MediaKind } from './prefsStore.js'

// Orchestrates the index: rebuild on demand, keep it fresh, and never run two builds at once
// (each one pulls the provider's whole catalogue, so a stampede would be worse than a stale
// index). Searching always works off whatever is indexed right now.

const INDEX_TTL_MS = 24 * 3_600_000

export interface SearchStatus extends SearchIndexStats {
  indexing: boolean
  lastError: string | null
}

export function createSearchService({ dataDir }: { dataDir: string }) {
  const store = createSearchStore({ dataDir })
  const lists = createProviderLists()
  let indexing: Promise<SearchStatus> | null = null
  let lastError: string | null = null

  function status(): SearchStatus {
    return { ...store.stats(), indexing: indexing !== null, lastError }
  }

  function rebuild(credentials: ProviderCredentials): Promise<SearchStatus> {
    if (indexing) return indexing
    const run = (async (): Promise<SearchStatus> => {
      try {
        lastError = null
        // Sequential rather than parallel: these are three multi-megabyte catalogue downloads
        // from one IPTV account, and hammering the provider is how accounts get rate-limited.
        store.replaceKind('live', await lists.live(credentials))
        store.replaceKind('movie', await lists.movies(credentials))
        store.replaceKind('series', await lists.series(credentials))
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err)
      } finally {
        indexing = null
      }
      return status()
    })()
    indexing = run
    return run
  }

  /** Starts a background rebuild when the index is missing or older than its TTL. */
  function ensureFresh(credentials: ProviderCredentials): void {
    if (indexing) return
    if (!store.isStale(INDEX_TTL_MS)) return
    void rebuild(credentials)
  }

  return {
    status,
    rebuild,
    ensureFresh,
    search: (query: string, limit?: number, kind?: MediaKind): SearchHit[] => store.search(query, limit, kind),
    clear: (): void => store.clear()
  }
}

export type SearchService = ReturnType<typeof createSearchService>

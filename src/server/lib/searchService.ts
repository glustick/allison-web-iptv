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

export interface SearchPlaylist {
  playlistId: string
  credentials: ProviderCredentials
}

export function createSearchService({ dataDir }: { dataDir: string }) {
  const store = createSearchStore({ dataDir })
  const lists = createProviderLists()
  let indexing: Promise<SearchStatus> | null = null
  let lastError: string | null = null

  function status(): SearchStatus {
    return { ...store.stats(), indexing: indexing !== null, lastError }
  }

  function rebuild(playlists: SearchPlaylist[]): Promise<SearchStatus> {
    if (indexing) return indexing
    const run = (async (): Promise<SearchStatus> => {
      lastError = null
      const failures: string[] = []
      for (const playlist of playlists) {
        // Sequential rather than parallel, within a playlist and across them: these are three
        // multi-megabyte catalogue downloads per IPTV account, and hammering providers is how
        // accounts get rate-limited. A playlist that fails is logged and skipped — one dead
        // provider must not leave the other playlists unsearchable (the independent-failures
        // rule every other multi-playlist surface follows).
        try {
          store.replaceKind('live', playlist.playlistId, await lists.live(playlist.credentials))
          store.replaceKind('movie', playlist.playlistId, await lists.movies(playlist.credentials))
          store.replaceKind('series', playlist.playlistId, await lists.series(playlist.credentials))
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          const label = playlist.playlistId === '' ? 'primary' : `"${playlist.playlistId}"`
          failures.push(`${label}: ${message}`)
        }
      }
      lastError = failures.length > 0 ? failures.join('; ') : null
      indexing = null
      return status()
    })()
    indexing = run
    return run
  }

  /** Starts a background rebuild when the index is missing or older than its TTL. */
  function ensureFresh(playlists: SearchPlaylist[]): void {
    if (indexing) return
    if (!store.isStale(INDEX_TTL_MS)) return
    void rebuild(playlists)
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

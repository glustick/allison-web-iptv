import { createNodeUpstreamRequest } from './nodeUpstreamRequest.js'
import { fetchTextViaUpstream } from './upstreamText.js'
import type { MediaKind } from './prefsStore.js'

// Fetches the provider's flat catalogues for indexing. The web client already pulls these through
// the proxy for browsing; search needs them server-side so the index can be built once and then
// survive restarts, provider hiccups and slow first loads.

export interface IndexRow {
  kind: MediaKind
  streamId: number
  name: string
  category: string | null
  icon: string | null
}

export interface ProviderCredentials {
  server: string
  username: string
  password: string
}

interface RawEntry {
  stream_id?: unknown
  series_id?: unknown
  name?: unknown
  title?: unknown
  stream_icon?: unknown
  cover?: unknown
  category_id?: unknown
}

interface RawCategory {
  category_id?: unknown
  category_name?: unknown
}

const LIST_STALL_TIMEOUT_MS = 120_000

function base(credentials: ProviderCredentials): string {
  return credentials.server.trim().replace(/\/+$/, '')
}

function api(credentials: ProviderCredentials, params: string): string {
  return `${base(credentials)}/player_api.php?username=${encodeURIComponent(credentials.username)}&password=${encodeURIComponent(
    credentials.password
  )}${params}`
}

/** Category id → name, best effort: a search result reads better with "UK | News" than "12". */
async function categoryNames(
  createUpstreamRequest: typeof createNodeUpstreamRequest,
  credentials: ProviderCredentials,
  action: string
): Promise<Map<string, string>> {
  try {
    const body = await fetchTextViaUpstream(createUpstreamRequest, api(credentials, `&action=${action}`), LIST_STALL_TIMEOUT_MS)
    const parsed = JSON.parse(body) as RawCategory[]
    const map = new Map<string, string>()
    for (const entry of Array.isArray(parsed) ? parsed : []) {
      if (entry?.category_id !== undefined && typeof entry.category_name === 'string') {
        map.set(String(entry.category_id), entry.category_name)
      }
    }
    return map
  } catch {
    return new Map()
  }
}

export function createProviderLists({ createUpstreamRequest = createNodeUpstreamRequest } = {}) {
  async function fetchList(
    credentials: ProviderCredentials,
    action: string,
    kind: MediaKind,
    idField: 'stream_id' | 'series_id',
    nameField: 'name' | 'title',
    iconField: 'stream_icon' | 'cover'
  ): Promise<IndexRow[]> {
    const body = await fetchTextViaUpstream(createUpstreamRequest, api(credentials, `&action=${action}`), LIST_STALL_TIMEOUT_MS)
    const parsed = JSON.parse(body) as RawEntry[]
    const names = await categoryNames(
      createUpstreamRequest,
      credentials,
      kind === 'live' ? 'get_live_categories' : kind === 'movie' ? 'get_vod_categories' : 'get_series_categories'
    )
    const rows: IndexRow[] = []
    for (const entry of Array.isArray(parsed) ? parsed : []) {
      const id = Number(entry?.[idField])
      const name = entry?.[nameField]
      if (!Number.isFinite(id) || typeof name !== 'string' || name.trim().length === 0) continue
      const icon = entry?.[iconField]
      rows.push({
        kind,
        streamId: id,
        name: name.trim(),
        category: entry?.category_id !== undefined ? names.get(String(entry.category_id)) ?? null : null,
        icon: typeof icon === 'string' && /^https?:\/\//i.test(icon) ? icon : null
      })
    }
    return rows
  }

  return {
    live: (credentials: ProviderCredentials): Promise<IndexRow[]> =>
      fetchList(credentials, 'get_live_streams', 'live', 'stream_id', 'name', 'stream_icon'),
    movies: (credentials: ProviderCredentials): Promise<IndexRow[]> =>
      fetchList(credentials, 'get_vod_streams', 'movie', 'stream_id', 'name', 'stream_icon'),
    series: (credentials: ProviderCredentials): Promise<IndexRow[]> =>
      fetchList(credentials, 'get_series', 'series', 'series_id', 'name', 'cover')
  }
}

export type ProviderLists = ReturnType<typeof createProviderLists>

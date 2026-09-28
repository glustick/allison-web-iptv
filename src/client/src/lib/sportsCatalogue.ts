import type { Category, LiveStream } from './types'

// Client side of the Sports tab's catalogue.
//
// The provider's live categories and the sports channels are fetched by the **server**
// (src/server/lib/sportsCatalogue.ts), cached on disk and shared by every account, so opening the
// tab does not re-fetch them and neither does a restart — the operator's ask (2026-09-28): once a
// day, persistent for all users. Classification stays here, which is why this asks for the ids.

export interface SportsCatalogueResponse {
  categories: Category[]
  categoriesFetchedAt: number | null
  streams: LiveStream[]
  streamsFetchedAt: number | null
  errors: string[]
  /** Category ids the server could not answer for at all. */
  missing: string[]
}

/**
 * The catalogue. With no ids, only the category list comes back; with ids, their streams too.
 * Both halves are cached server-side for a day, so the second call is served from that cache.
 */
export async function fetchSportsCatalogue(categoryIds: string[] = []): Promise<SportsCatalogueResponse> {
  const query = categoryIds.length > 0 ? `?categories=${encodeURIComponent(categoryIds.join(','))}` : ''
  const res = await fetch(`/api/sports/catalogue${query}`)
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(data.error ?? `Could not load the sports catalogue (${res.status})`)
  }
  const data = (await res.json()) as Partial<SportsCatalogueResponse>
  return {
    categories: Array.isArray(data.categories) ? (data.categories as Category[]) : [],
    categoriesFetchedAt: typeof data.categoriesFetchedAt === 'number' ? data.categoriesFetchedAt : null,
    streams: Array.isArray(data.streams) ? (data.streams as LiveStream[]) : [],
    streamsFetchedAt: typeof data.streamsFetchedAt === 'number' ? data.streamsFetchedAt : null,
    errors: Array.isArray(data.errors) ? data.errors.filter((message): message is string => typeof message === 'string') : [],
    missing: Array.isArray(data.missing) ? data.missing.filter((id): id is string => typeof id === 'string') : []
  }
}

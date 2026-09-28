import { mkdir, readFile, rename, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import { fetchTextViaUpstream } from './upstreamText.js'
import { createNodeUpstreamRequest } from './nodeUpstreamRequest.js'

// The Sports tab's catalogue: the provider's live categories, and the streams of the categories
// that classify as sports.
//
// The operator asked for the EPG's treatment (2026-09-28) — **persistent for all users, fetched
// once a day, not rebuilt per login**. So it is fetched by the server, cached on disk, shared by
// every account, and re-read after a restart instead of re-fetched.
//
// Classification deliberately stays on the client (lib/sports.ts owns the only copy of the league
// rules), so the client tells this service which category ids it wants and each one is cached on
// its own. The ids the client last asked for are remembered, which is what lets the 1am warm
// refresh exactly the right things without duplicating that rule table here.

const FILE_NAME = 'sports-catalogue.json'
const TTL_MS = 24 * 3_600_000
// The channel list is a bulk download from a busy endpoint; the same generous window the EPG
// service gives it.
const STALL_TIMEOUT_MS = 60_000
const RESPONSE_TIMEOUT_MS = 30_000

export type CatalogueRow = Record<string, unknown>

interface Entry {
  fetchedAt: number
  rows: CatalogueRow[]
  error: string | null
}

interface StoredFile {
  version: 1
  categories?: Entry | null
  streams?: Record<string, Entry>
  /** The sports category ids the client last asked for — what the nightly warm refreshes. */
  lastCategoryIds?: string[]
}

export interface CatalogueCredentials {
  server: string
  username: string
  password: string
}

export interface CategoriesResult {
  rows: CatalogueRow[]
  fetchedAt: number | null
  error: string | null
}

export interface StreamsResult {
  rows: CatalogueRow[]
  fetchedAt: number | null
  errors: string[]
  /** Ids that could not be answered at all (first fetch failed and nothing was cached). */
  missing: string[]
}

export interface SportsCatalogueDeps {
  dataDir?: string
  createUpstreamRequest?: typeof createNodeUpstreamRequest
  now?: () => number
  ttlMs?: number
}

export function createSportsCatalogueService(deps: SportsCatalogueDeps = {}) {
  const createUpstreamRequest = deps.createUpstreamRequest ?? createNodeUpstreamRequest
  const now = deps.now ?? Date.now
  const ttlMs = deps.ttlMs ?? TTL_MS
  const dataDir = deps.dataDir

  let categories: Entry | null = null
  const streams = new Map<string, Entry>()
  let lastIds: string[] = []
  let loaded = false
  let loading: Promise<void> | null = null

  const inFlight = new Map<string, Promise<Entry>>()

  function filePath(): string | null {
    return dataDir ? join(dataDir, FILE_NAME) : null
  }

  async function ensureLoaded(): Promise<void> {
    if (loaded) return
    if (loading) return loading
    loading = (async () => {
      const path = filePath()
      try {
        if (path) {
          const raw = JSON.parse(await readFile(path, 'utf8')) as StoredFile
          categories = raw.categories ?? null
          for (const [id, entry] of Object.entries(raw.streams ?? {})) streams.set(id, entry)
          lastIds = Array.isArray(raw.lastCategoryIds) ? raw.lastCategoryIds.filter((id) => typeof id === 'string') : []
        }
      } catch (err) {
        // A missing file is the cold path; anything else is worth knowing but not fatal — the
        // catalogue is simply fetched again.
        if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
          console.error('[sports] could not read the cached catalogue:', err instanceof Error ? err.message : err)
        }
      }
      loaded = true
    })().finally(() => {
      loading = null
    })
    return loading
  }

  async function persist(): Promise<void> {
    const path = filePath()
    if (!path) return
    const payload: StoredFile = {
      version: 1,
      categories,
      streams: Object.fromEntries(streams),
      lastCategoryIds: lastIds
    }
    const tmp = `${path}.tmp`
    try {
      await mkdir(dirname(path), { recursive: true })
      // Temp name + rename, so a crash mid-write cannot leave a half catalogue to be parsed.
      await writeFile(tmp, JSON.stringify(payload), 'utf8')
      await rename(tmp, path)
    } catch (err) {
      console.error('[sports] could not cache the catalogue:', err instanceof Error ? err.message : err)
    }
  }

  function isFresh(entry: Entry | null): boolean {
    return Boolean(entry && entry.error === null && now() - entry.fetchedAt < ttlMs)
  }

  /** Cache-or-fetch for one key (the category list, or one category's streams). */
  async function ensure(key: string, current: Entry | null, fetcher: () => Promise<Entry>): Promise<Entry> {
    await ensureLoaded()
    if (isFresh(current)) return current as Entry
    const existing = inFlight.get(key)
    if (existing) return existing
    const promise = fetcher()
      .then(async (entry) => {
        // A failed refresh keeps the rows we already had — a day-old channel list beats an empty
        // Sports tab — and records why.
        const next: Entry =
          entry.error !== null && current
            ? { fetchedAt: current.fetchedAt, rows: current.rows, error: entry.error }
            : entry
        if (key === 'categories') categories = next
        else streams.set(key, next)
        await persist()
        return next
      })
      .finally(() => inFlight.delete(key))
    inFlight.set(key, promise)
    return promise
  }

  function providerBase(credentials: CatalogueCredentials): string {
    return credentials.server.trim().replace(/\/+$/, '')
  }

  async function fetchRows(credentials: CatalogueCredentials, params: Record<string, string>): Promise<CatalogueRow[]> {
    const url = new URL(`${providerBase(credentials)}/player_api.php`)
    url.searchParams.set('username', credentials.username)
    url.searchParams.set('password', credentials.password)
    for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value)
    const body = await fetchTextViaUpstream(
      createUpstreamRequest,
      url.toString(),
      STALL_TIMEOUT_MS,
      undefined,
      RESPONSE_TIMEOUT_MS
    )
    const parsed = JSON.parse(body) as unknown
    return Array.isArray(parsed) ? (parsed as CatalogueRow[]) : []
  }

  async function fetchEntry(credentials: CatalogueCredentials, params: Record<string, string>): Promise<Entry> {
    try {
      return { fetchedAt: now(), rows: await fetchRows(credentials, params), error: null }
    } catch (err) {
      return { fetchedAt: now(), rows: [], error: err instanceof Error ? err.message : String(err) }
    }
  }

  async function getCategories(credentials: CatalogueCredentials): Promise<CategoriesResult> {
    const entry = await ensure('categories', categories, () =>
      fetchEntry(credentials, { action: 'get_live_categories' })
    )
    return { rows: entry.rows, fetchedAt: entry.rows.length > 0 ? entry.fetchedAt : null, error: entry.error }
  }

  async function getStreams(credentials: CatalogueCredentials, categoryIds: string[]): Promise<StreamsResult> {
    await ensureLoaded()
    // Remembered for the nightly warm (see lastCategoryIds).
    if (categoryIds.length > 0 && JSON.stringify(categoryIds) !== JSON.stringify(lastIds)) {
      lastIds = [...categoryIds]
      void persist()
    }
    const rows: CatalogueRow[] = []
    const errors: string[] = []
    const missing: string[] = []
    let oldest: number | null = null
    for (const categoryId of categoryIds) {
      const entry = await ensure(categoryId, streams.get(categoryId) ?? null, () =>
        fetchEntry(credentials, { action: 'get_live_streams', category_id: categoryId })
      )
      if (entry.error) errors.push(entry.error)
      if (entry.rows.length === 0 && entry.error) {
        missing.push(categoryId)
        continue
      }
      rows.push(...entry.rows)
      oldest = oldest === null ? entry.fetchedAt : Math.min(oldest, entry.fetchedAt)
    }
    return { rows, fetchedAt: oldest, errors, missing }
  }

  return {
    getCategories,
    getStreams,
    /** The ids the client last asked for — what the 1am warm refreshes. */
    lastCategoryIds(): string[] {
      return [...lastIds]
    },
    /** Forces a refetch of the given keys (used by the nightly warm and by a manual refresh). */
    async refresh(credentials: CatalogueCredentials, categoryIds: string[]): Promise<void> {
      await ensureLoaded()
      categories = null
      await ensure('categories', null, () => fetchEntry(credentials, { action: 'get_live_categories' }))
      for (const categoryId of categoryIds) {
        streams.delete(categoryId)
      }
      if (categoryIds.length > 0) await getStreams(credentials, categoryIds)
    },
    status(): { categoriesFetchedAt: number | null; categories: number; streams: Record<string, number> } {
      return {
        categoriesFetchedAt: categories?.fetchedAt ?? null,
        categories: categories?.rows.length ?? 0,
        streams: Object.fromEntries([...streams.entries()].map(([id, entry]) => [id, entry.rows.length]))
      }
    },
    /** Test/ops hook. */
    clearCache(): void {
      categories = null
      streams.clear()
      lastIds = []
      loaded = false
    }
  }
}

export type SportsCatalogueService = ReturnType<typeof createSportsCatalogueService>

import { describe, it, expect, afterEach } from 'vitest'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'
import type { AddressInfo } from 'net'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createSportsCatalogueService } from './sportsCatalogue.js'
import { createNodeUpstreamRequest } from './nodeUpstreamRequest.js'

// The Sports tab's catalogue is fetched by the server, cached on disk and shared, so opening the tab
// (or restarting the app) must not re-fetch the provider's list. Driven against a real local origin,
// the same discipline the EPG service's tests use.

const servers: Server[] = []
const dirs: string[] = []

async function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<string> {
  const server = createServer(handler)
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return `http://127.0.0.1:${port}`
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sports-catalogue-'))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
  // The catalogue persists in the background on purpose (a multi-megabyte write must not block a
  // request), so give that write a moment to land before the temp dir is removed.
  await new Promise((resolve) => setTimeout(resolve, 50))
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

interface Counters {
  categories: number
  streams: Record<string, number>
}

async function catalogueOrigin(counters: Counters, failStreamsFor: string | null = null): Promise<string> {
  return listen((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const action = url.searchParams.get('action')
    if (action === 'get_live_categories') {
      counters.categories += 1
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify([
          { category_id: '100', category_name: 'Live | English Premier League - EPL', parent_id: 0 },
          { category_id: '200', category_name: 'UK | Sky Sports', parent_id: 0 }
        ])
      )
      return
    }
    const categoryId = url.searchParams.get('category_id') ?? ''
    counters.streams[categoryId] = (counters.streams[categoryId] ?? 0) + 1
    if (failStreamsFor === categoryId) {
      res.writeHead(500)
      res.end('boom')
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify([{ stream_id: Number(categoryId), name: `Channel ${categoryId}`, category_id: categoryId, num: 1 }]))
  })
}

function newCounters(): Counters {
  return { categories: 0, streams: {} }
}

const credentials = (server: string): { server: string; username: string; password: string } => ({
  server,
  username: 'user',
  password: 'pass'
})

describe('sports catalogue', () => {
  it('fetches the categories once and serves them from cache', async () => {
    const counters = newCounters()
    const origin = await catalogueOrigin(counters)
    const service = createSportsCatalogueService({ createUpstreamRequest: createNodeUpstreamRequest, dataDir: tempDir() })

    const first = await service.getCategories(credentials(origin))
    expect(first.rows).toHaveLength(2)
    expect(first.fetchedAt).not.toBeNull()
    await service.getCategories(credentials(origin))
    expect(counters.categories).toBe(1)
  })

  it('caches each category separately and only fetches what it lacks', async () => {
    const counters = newCounters()
    const origin = await catalogueOrigin(counters)
    const service = createSportsCatalogueService({ createUpstreamRequest: createNodeUpstreamRequest, dataDir: tempDir() })

    const first = await service.getStreams(credentials(origin), ['100', '200'])
    expect(first.rows).toHaveLength(2)
    expect(counters.streams).toEqual({ 100: 1, 200: 1 })

    // Only the new id is fetched; the two already cached are not.
    const second = await service.getStreams(credentials(origin), ['100', '200', '300'])
    expect(second.rows).toHaveLength(3)
    expect(counters.streams['100']).toBe(1)
    expect(counters.streams['200']).toBe(1)
    expect(counters.streams['300']).toBe(1)
  })

  it('reuses the disk copy after a restart instead of re-fetching', async () => {
    const dir = tempDir()
    const counters = newCounters()
    const origin = await catalogueOrigin(counters)
    const first = createSportsCatalogueService({ createUpstreamRequest: createNodeUpstreamRequest, dataDir: dir })
    await first.getStreams(credentials(origin), ['100'])
    expect(counters.streams).toEqual({ 100: 1 })

    const restarted = createSportsCatalogueService({ createUpstreamRequest: createNodeUpstreamRequest, dataDir: dir })
    const after = await restarted.getStreams(credentials(origin), ['100'])
    expect(after.rows).toHaveLength(1)
    expect(counters.streams).toEqual({ 100: 1 })
  })

  it('honours the daily window', async () => {
    const counters = newCounters()
    const origin = await catalogueOrigin(counters)
    let clock = Date.parse('2026-09-28T02:00:00Z')
    const service = createSportsCatalogueService({
      createUpstreamRequest: createNodeUpstreamRequest,
      dataDir: tempDir(),
      ttlMs: 24 * 3_600_000,
      now: () => clock
    })
    await service.getCategories(credentials(origin))
    clock += 23 * 3_600_000
    await service.getCategories(credentials(origin))
    expect(counters.categories).toBe(1)
    // Past the day, it is fetched again — which is what the 01:00 warm also does.
    clock += 2 * 3_600_000
    await service.getCategories(credentials(origin))
    expect(counters.categories).toBe(2)
  })

  it('remembers the ids it was asked for, so the nightly warm can refresh them', async () => {
    const counters = newCounters()
    const origin = await catalogueOrigin(counters)
    const dir = tempDir()
    const service = createSportsCatalogueService({ createUpstreamRequest: createNodeUpstreamRequest, dataDir: dir })
    await service.getStreams(credentials(origin), ['100', '200'])
    expect(service.lastCategoryIds()).toEqual(['100', '200'])
    // …and the memory survives a restart, because the warm runs in a fresh process too.
    const restarted = createSportsCatalogueService({ createUpstreamRequest: createNodeUpstreamRequest, dataDir: dir })
    await restarted.getCategories(credentials(origin))
    expect(restarted.lastCategoryIds()).toEqual(['100', '200'])
  })

  it('keeps the rows it already had when a refresh fails, and reports why', async () => {
    const counters = newCounters()
    const origin = await catalogueOrigin(counters)
    let clock = Date.parse('2026-09-28T02:00:00Z')
    const service = createSportsCatalogueService({
      createUpstreamRequest: createNodeUpstreamRequest,
      dataDir: tempDir(),
      ttlMs: 1_000,
      now: () => clock
    })
    await service.getStreams(credentials(origin), ['100'])
    clock += 5_000
    // The origin starts refusing; a day-old channel list beats an empty Sports tab.
    const failing = await catalogueOrigin(counters, '100')
    const after = await service.getStreams(credentials(failing), ['100'])
    expect(after.rows).toHaveLength(1)
    expect(after.errors.join(' ')).toMatch(/500/)
  })

  it('refresh forces a re-fetch of the named categories', async () => {
    const counters = newCounters()
    const origin = await catalogueOrigin(counters)
    const service = createSportsCatalogueService({ createUpstreamRequest: createNodeUpstreamRequest, dataDir: tempDir() })
    await service.getStreams(credentials(origin), ['100'])
    await service.refresh(credentials(origin), ['100'])
    expect(counters.streams['100']).toBe(2)
  })
})

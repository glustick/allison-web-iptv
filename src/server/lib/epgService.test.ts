import { describe, it, expect, afterEach } from 'vitest'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'
import type { AddressInfo } from 'net'
import { createEpgService } from './epgService.js'
import { createNodeUpstreamRequest } from './nodeUpstreamRequest.js'

// Same discipline as nodeUpstreamRequest.test.ts / proxyServer.test.ts: exercise the real Node
// networking stack against real local HTTP servers standing in for the provider and an external
// XMLTV source, rather than mocking fetch shapes — the fetch/redirect/stall machinery this
// service rides on is exactly the kind of thing a mock gets subtly wrong.

const NOW = Date.parse('2026-01-15T12:00:00Z')
const HOUR = 3_600_000

function xmltvDate(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())} +0000`
}

function guideXml(channels: Array<{ id: string; displayName: string; programmes: Array<{ startMs: number; stopMs: number; title: string }> }>): string {
  const channelXml = channels.map((c) => `<channel id="${c.id}"><display-name>${c.displayName}</display-name></channel>`).join('')
  const programmeXml = channels
    .flatMap((c) => c.programmes.map((p) => `<programme channel="${c.id}" start="${xmltvDate(p.startMs)}" stop="${xmltvDate(p.stopMs)}"><title>${p.title}</title></programme>`))
    .join('')
  return `<?xml version="1.0"?><tv>${channelXml}${programmeXml}</tv>`
}

const servers: Server[] = []

async function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<string> {
  const server = createServer(handler)
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return `http://127.0.0.1:${port}`
}

afterEach(async () => {
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
  servers.length = 0
})

function fakeClock(): { now: () => number; advance: (ms: number) => void } {
  let current = NOW
  return { now: () => current, advance: (ms) => { current += ms } }
}

// Stale-while-revalidate serves the cached guide immediately and refreshes in the background,
// so a test observing "the refetch happened" has to poll for the upstream hit rather than
// asserting it synchronously after aggregate() resolves.
async function until(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Condition not met before timeout')
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

describe('createEpgService', () => {
  it('aggregates provider-first, fills gaps from external sources, and window-filters', async () => {
    let providerGuideHits = 0
    const provider = await listen((req, res) => {
      if (req.url?.startsWith('/xmltv.php')) {
        providerGuideHits++
        res.writeHead(200, { 'content-type': 'application/xml' })
        res.end(
          guideXml([
            // Exact-id join for stream 1.
            { id: 'prov-exact', displayName: 'Provider Exact', programmes: [{ startMs: NOW, stopMs: NOW + HOUR, title: 'Provider Exact programme' }] },
            // Provider wins for stream 4 even though the external guide also has a channel of
            // the same normalized name.
            { id: 'prov-both', displayName: 'Contested Channel', programmes: [{ startMs: NOW, stopMs: NOW + HOUR, title: 'PROVIDER version' }] },
            // Outside the requested window — must not be served.
            { id: 'prov-window', displayName: 'Window Tester', programmes: [{ startMs: NOW + 48 * HOUR, stopMs: NOW + 49 * HOUR, title: 'Far outside the window' }] }
          ])
        )
        return
      }
      if (req.url?.includes('action=get_live_streams')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify([
            { stream_id: 1, name: 'Whatever The Stream Name', epg_channel_id: 'prov-exact' },
            { stream_id: 2, name: 'UK: External Only', epg_channel_id: null },
            { stream_id: 3, name: 'External FHD', epg_channel_id: 'Ext-Formatted_ID' },
            { stream_id: 4, name: 'Contested Channel HD', epg_channel_id: 'prov-both' },
            { stream_id: 5, name: 'Window Tester', epg_channel_id: 'prov-window' }
          ])
        )
        return
      }
      res.writeHead(404)
      res.end()
    })

    const external = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/xml' })
      res.end(
        guideXml([
          // Name-only join for stream 2 ("UK: External Only" → "external only").
          { id: 'ext-name', displayName: 'External Only', programmes: [{ startMs: NOW + HOUR, stopMs: NOW + 2 * HOUR, title: 'External Only programme' }] },
          // Normalized-id join for stream 3.
          { id: 'ext-formatted-id', displayName: 'Something Else Entirely', programmes: [{ startMs: NOW, stopMs: NOW + HOUR, title: 'Normalized id programme' }] },
          // Loses to the provider for stream 4.
          { id: 'ext-both', displayName: 'Contested Channel', programmes: [{ startMs: NOW, stopMs: NOW + HOUR, title: 'EXTERNAL version' }] }
        ])
      )
    })

    const service = createEpgService({ createUpstreamRequest: createNodeUpstreamRequest, now: fakeClock().now })
    const result = await service.aggregate({
      credentials: { server: provider, username: 'user', password: 'pass' },
      epgUrls: [external],
      startMs: NOW - HOUR,
      endMs: NOW + 4 * HOUR
    })

    expect(Object.keys(result.listings).sort()).toEqual(['1', '2', '3', '4'])
    expect(result.listings['1'].map((p) => p.title)).toEqual(['Provider Exact programme'])
    expect(result.listings['2'].map((p) => p.title)).toEqual(['External Only programme'])
    expect(result.listings['3'].map((p) => p.title)).toEqual(['Normalized id programme'])
    expect(result.listings['4'].map((p) => p.title)).toEqual(['PROVIDER version'])
    expect(result.sources.map((s) => s.kind)).toEqual(['provider', 'external'])
    expect(result.sources.every((s) => s.status === 'ok')).toBe(true)
    expect(providerGuideHits).toBe(1)
  })

  it('reports a failing external source as an error while still serving the provider guide', async () => {
    const provider = await listen((req, res) => {
      if (req.url?.startsWith('/xmltv.php')) {
        res.writeHead(200)
        res.end(guideXml([{ id: 'c1', displayName: 'Fine', programmes: [{ startMs: NOW, stopMs: NOW + HOUR, title: 'Provider programme' }] }]))
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify([{ stream_id: 1, name: 'Fine', epg_channel_id: 'c1' }]))
    })
    const broken = await listen((_req, res) => {
      res.writeHead(500)
      res.end('boom')
    })

    const service = createEpgService({ createUpstreamRequest: createNodeUpstreamRequest, now: fakeClock().now })
    const result = await service.aggregate({
      credentials: { server: provider, username: 'user', password: 'pass' },
      epgUrls: [broken],
      startMs: NOW - HOUR,
      endMs: NOW + HOUR
    })

    expect(result.listings['1'].map((p) => p.title)).toEqual(['Provider programme'])
    const externalSource = result.sources.find((s) => s.kind === 'external')
    expect(externalSource?.status).toBe('error')
    expect(externalSource?.error).toBeTruthy()
  })

  it('serves a cached guide within the TTL and refetches once it expires', async () => {
    const clock = fakeClock()
    let guideHits = 0
    const provider = await listen((req, res) => {
      if (req.url?.startsWith('/xmltv.php')) {
        guideHits++
        res.writeHead(200)
        res.end(guideXml([{ id: 'c1', displayName: 'Cached', programmes: [{ startMs: NOW, stopMs: NOW + HOUR, title: `Version ${guideHits}` }] }]))
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify([{ stream_id: 1, name: 'Cached', epg_channel_id: 'c1' }]))
    })

    const service = createEpgService({ createUpstreamRequest: createNodeUpstreamRequest, guideTtlMs: 1_000, now: clock.now })
    const credentials = { server: provider, username: 'user', password: 'pass' }

    const first = await service.aggregate({ credentials, epgUrls: [], startMs: NOW - HOUR, endMs: NOW + HOUR })
    expect(first.listings['1'][0].title).toBe('Version 1')
    expect(guideHits).toBe(1)

    // Within the TTL: served from cache, no new upstream fetch.
    const second = await service.aggregate({ credentials, epgUrls: [], startMs: NOW - HOUR, endMs: NOW + HOUR })
    expect(guideHits).toBe(1)
    expect(second.listings['1'][0].title).toBe('Version 1')

    // Past the TTL: this call serves the stale guide and kicks off a background refresh…
    clock.advance(1_500)
    const third = await service.aggregate({ credentials, epgUrls: [], startMs: NOW - HOUR, endMs: NOW + HOUR })
    expect(guideHits).toBe(1)
    expect(third.listings['1'][0].title).toBe('Version 1')
    // …and once that refresh lands, the next call sees the fresh guide.
    await until(() => guideHits === 2)
    const fourth = await service.aggregate({ credentials, epgUrls: [], startMs: NOW - HOUR, endMs: NOW + HOUR })
    expect(fourth.listings['1'][0].title).toBe('Version 2')
  })

  it('keeps serving the last good guide when a refresh fails (stale-while-revalidate)', async () => {
    const clock = fakeClock()
    let healthy = true
    let guideHits = 0
    const provider = await listen((req, res) => {
      if (req.url?.startsWith('/xmltv.php')) {
        guideHits++
        if (!healthy) {
          res.writeHead(503)
          res.end('temporarily down')
          return
        }
        res.writeHead(200)
        res.end(guideXml([{ id: 'c1', displayName: 'Stale', programmes: [{ startMs: NOW, stopMs: NOW + HOUR, title: 'Good version' }] }]))
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify([{ stream_id: 1, name: 'Stale', epg_channel_id: 'c1' }]))
    })

    const service = createEpgService({ createUpstreamRequest: createNodeUpstreamRequest, guideTtlMs: 1_000, now: clock.now })
    const credentials = { server: provider, username: 'user', password: 'pass' }

    await service.aggregate({ credentials, epgUrls: [], startMs: NOW - HOUR, endMs: NOW + HOUR })
    healthy = false
    clock.advance(1_500)
    const afterOutage = await service.aggregate({ credentials, epgUrls: [], startMs: NOW - HOUR, endMs: NOW + HOUR })
    expect(afterOutage.listings['1'][0].title).toBe('Good version')
    expect(afterOutage.sources[0].status).toBe('ok')
    // The failed refresh was still attempted in the background (and keeps the old guide live).
    await until(() => guideHits === 2)
  })
})

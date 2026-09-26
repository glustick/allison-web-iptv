import { describe, it, expect, afterEach } from 'vitest'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'
import { gzipSync } from 'zlib'
import type { AddressInfo } from 'net'
import { createEpgService, EPG_ERROR_RETRY_BASE_MS, EPG_ERROR_RETRY_MAX_MS, epgRetryDelayMs } from './epgService.js'
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

  it('reports download progress (bytes against content-length) while a guide is in flight', async () => {
    // The provider guide is a ~97MB download on a flaky edge; a bare "loading" made a stalled
    // fetch indistinguishable from a working one, and a download that died midway reported no
    // position. The origin streams a declared content-length in slices, and the non-blocking
    // status is polled while aggregate() is still running — the exact reading the EPG screen
    // shows the operator.
    // A realistic ~400KB guide: thousands of real channel entries, streamed in slices against a
    // declared content-length — not blank padding, which is not what a big guide looks like.
    const entry = '<channel id="c1"><display-name>Chan</display-name><programme start="20260115120000 +0000" stop="20260115130000 +0000"><title>t</title></programme></channel>'
    const body = Buffer.from(`<?xml version="1.0"?><tv>${entry.repeat(2400)}</tv>`)
    const provider = await listen((req, res) => {
      if (req.url?.startsWith('/xmltv.php')) {
        res.writeHead(200, { 'content-type': 'application/xml', 'content-length': String(body.length) })
        let offset = 0
        const timer = setInterval(() => {
          if (offset >= body.length) {
            clearInterval(timer)
            res.end()
            return
          }
          const slice = body.subarray(offset, Math.min(offset + 25_000, body.length))
          offset += slice.length
          res.write(slice)
        }, 50)
        res.on('close', () => clearInterval(timer))
        return
      }
      if (req.url?.includes('action=get_live_streams')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('[]')
        return
      }
      res.writeHead(404)
      res.end()
    })
    const service = createEpgService({ createUpstreamRequest: createNodeUpstreamRequest, now: fakeClock().now })
    const credentials = { server: provider, username: 'user', password: 'pass' }
    const aggregatePromise = service.aggregate({
      credentials,
      epgUrls: [],
      startMs: NOW - HOUR,
      endMs: NOW + HOUR
    })

    // Mid-flight: bytes received so far, against the size the server declared.
    await until(() => {
      const s = service.peekStatus({ credentials, epgUrls: [] }).find((x) => x.kind === 'provider')
      return Boolean(s?.progress && s.progress.receivedBytes > 0)
    })
    const mid = service.peekStatus({ credentials, epgUrls: [] }).find((x) => x.kind === 'provider')
    expect(mid?.progress?.totalBytes).toBe(body.length)
    expect(mid?.progress?.receivedBytes).toBeGreaterThan(0)
    expect(mid?.progress?.receivedBytes).toBeLessThan(body.length)

    // Completed: the final reading persists, so the guide's size stays visible.
    const result = await aggregatePromise
    const done = result.sources.find((s) => s.kind === 'provider')
    expect(done?.status).toBe('ok')
    expect(done?.progress?.receivedBytes).toBe(body.length)
    expect(done?.progress?.totalBytes).toBe(body.length)
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

  it('reports fuzzy matches, and reuses the memoised mapping across window requests', async () => {
    const provider = await listen((req, res) => {
      if (req.url?.startsWith('/xmltv.php')) {
        res.writeHead(200, { 'content-type': 'application/xml' })
        res.end(
          guideXml([
            { id: 'prov-sky', displayName: 'Sky Sports One HD', programmes: [{ startMs: NOW, stopMs: NOW + HOUR, title: 'Fuzzy match programme' }] }
          ])
        )
        return
      }
      if (req.url?.includes('action=get_live_streams')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify([
            // No epg_channel_id at all and a name that only matches after number-word folding —
            // exactly the case the fuzzy layer exists for.
            { stream_id: 1, name: 'Sky Sports 1', epg_channel_id: null },
            { stream_id: 2, name: 'Some Unrelated Feed', epg_channel_id: null }
          ])
        )
        return
      }
      res.writeHead(404)
      res.end()
    })

    const service = createEpgService({ createUpstreamRequest: createNodeUpstreamRequest, now: fakeClock().now })
    const credentials = { server: provider, username: 'user', password: 'pass' }

    const summary = await service.getMatchSummary({ credentials, epgUrls: [] })
    expect(summary.streams).toBe(2)
    expect(summary.matched).toBe(1)
    expect(summary.unmatched).toBe(1)
    expect(summary.byStrategy['fuzzy-name']).toBe(1)

    const first = await service.aggregate({ credentials, epgUrls: [], startMs: NOW, endMs: NOW + HOUR })
    expect(first.listings['1']?.[0]?.title).toBe('Fuzzy match programme')
    expect(first.listings['2']).toBeUndefined()

    // Second window request must reuse the memoised mapping (same result, no refetch).
    const second = await service.aggregate({ credentials, epgUrls: [], startMs: NOW, endMs: NOW + HOUR })
    expect(second.listings).toEqual(first.listings)

    // A refresh drops the caches so the next request refetches.
    service.refresh({ credentials, epgUrls: [] })
    const third = await service.aggregate({ credentials, epgUrls: [], startMs: NOW, endMs: NOW + HOUR })
    expect(third.listings).toEqual(first.listings)
  })

  it('parses a pre-compressed .xml.gz guide served without content-encoding', async () => {
    // The shape a real user's source had: a 7MB .gz file (48MB of XMLTV) served as
    // application/octet-stream. Read as UTF-8, the gzip bytes became binary junk that the XML
    // parser reported as "Maximum nested tags exceeded" — no parser tolerance could fix that.
    const xml = guideXml([
      { id: 'gz1', displayName: 'Gzipped Channel', programmes: [{ startMs: NOW, stopMs: NOW + HOUR, title: 'From a .gz' }] }
    ])
    const gz = gzipSync(Buffer.from(xml, 'utf-8'))

    const source = await listen((req, res) => {
      if (req.url?.startsWith('/xmltv.php') || req.url?.includes('action=get_live_streams')) {
        res.writeHead(404)
        res.end()
        return
      }
      res.writeHead(200, { 'content-type': 'application/octet-stream' })
      res.end(gz)
    })

    const provider = await listen((req, res) => {
      if (req.url?.startsWith('/xmltv.php')) {
        res.writeHead(200, { 'content-type': 'application/xml' })
        res.end(guideXml([{ id: 'prov', displayName: 'Provider', programmes: [{ startMs: NOW, stopMs: NOW + HOUR, title: 'Provider prog' }] }]))
        return
      }
      if (req.url?.includes('action=get_live_streams')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify([{ stream_id: 1, name: 'Gzipped Channel', epg_channel_id: null }]))
        return
      }
      res.writeHead(404)
      res.end()
    })

    const service = createEpgService({ createUpstreamRequest: createNodeUpstreamRequest, now: fakeClock().now })
    const result = await service.aggregate({
      credentials: { server: provider, username: 'user', password: 'pass' },
      epgUrls: [source],
      startMs: NOW,
      endMs: NOW + HOUR
    })
    const external = result.sources.find((s) => s.kind === 'external')
    expect(external?.status).toBe('ok')
    expect(external?.channelCount).toBe(1)
    expect(result.listings['1']?.[0]?.title).toBe('From a .gz')
  })

  it('does not double-decompress a response that is gzip-encoded', async () => {
    // The upstream layer already decompresses based on content-encoding; the guide decoder must
    // only act on the magic bytes of a .gz *file*, or this path would fail.
    const xml = guideXml([
      { id: 'enc1', displayName: 'Encoded Channel', programmes: [{ startMs: NOW, stopMs: NOW + HOUR, title: 'From an encoded body' }] }
    ])
    const source = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/xml', 'content-encoding': 'gzip' })
      res.end(gzipSync(Buffer.from(xml, 'utf-8')))
    })
    const provider = await listen((req, res) => {
      if (req.url?.includes('action=get_live_streams')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify([{ stream_id: 1, name: 'Encoded Channel', epg_channel_id: null }]))
        return
      }
      res.writeHead(404)
      res.end()
    })

    const service = createEpgService({ createUpstreamRequest: createNodeUpstreamRequest, now: fakeClock().now })
    const result = await service.aggregate({
      credentials: { server: provider, username: 'user', password: 'pass' },
      epgUrls: [source],
      startMs: NOW,
      endMs: NOW + HOUR
    })
    expect(result.sources.find((s) => s.kind === 'external')?.status).toBe('ok')
    expect(result.listings['1']?.[0]?.title).toBe('From an encoded body')
  })

  it('gives a paused bulk guide download the longer stall window (and fails fast without it)', async () => {
    // The reported "provider EPG error": a ~97MB guide that pauses mid-transfer is normal on a
    // busy provider, and the stream-oriented 20s watchdog aborted it. The guide fetcher now uses
    // a much longer window — and this test pins that it is actually applied.
    const xml = guideXml([{ id: 'p1', displayName: 'Paused Channel', programmes: [{ startMs: NOW, stopMs: NOW + HOUR, title: 'Slow' }] }])
    const slowServer = (pauseMs: number) =>
      listen((req, res) => {
        if (req.url?.startsWith('/xmltv.php') || req.url?.includes('action=get_live_streams')) {
          res.writeHead(404)
          res.end()
          return
        }
        res.writeHead(200, { 'content-type': 'application/xml' })
        // Send half the body, go quiet well past the configured window, then finish.
        res.write(xml.slice(0, Math.floor(xml.length / 2)))
        setTimeout(() => res.end(xml.slice(Math.floor(xml.length / 2))), pauseMs)
      })

    const provider = await listen((req, res) => {
      if (req.url?.includes('action=get_live_streams')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify([{ stream_id: 1, name: 'Paused Channel', epg_channel_id: null }]))
        return
      }
      res.writeHead(404)
      res.end()
    })

    const source = await slowServer(700)
    const strict = createEpgService({
      createUpstreamRequest: createNodeUpstreamRequest,
      guideStallTimeoutMs: 150,
      guideStallCheckIntervalMs: 50,
      now: fakeClock().now
    })
    const strictResult = await strict.aggregate({
      credentials: { server: provider, username: 'u', password: 'p' },
      epgUrls: [source],
      startMs: NOW,
      endMs: NOW + HOUR
    })
    expect(strictResult.sources.find((s) => s.kind === 'external')?.status).toBe('error')

    const tolerantSource = await slowServer(700)
    const tolerant = createEpgService({
      createUpstreamRequest: createNodeUpstreamRequest,
      guideStallTimeoutMs: 5000,
      guideStallCheckIntervalMs: 50,
      now: fakeClock().now
    })
    const tolerantResult = await tolerant.aggregate({
      credentials: { server: provider, username: 'u', password: 'p' },
      epgUrls: [tolerantSource],
      startMs: NOW,
      endMs: NOW + HOUR
    })
    expect(tolerantResult.sources.find((s) => s.kind === 'external')?.status).toBe('ok')
    expect(tolerantResult.listings['1']?.[0]?.title).toBe('Slow')
  })
})

describe('epgRetryDelayMs', () => {
  it('backs off exponentially and caps out', () => {
    expect(epgRetryDelayMs(1)).toBe(EPG_ERROR_RETRY_BASE_MS)
    expect(epgRetryDelayMs(2)).toBe(2 * EPG_ERROR_RETRY_BASE_MS)
    expect(epgRetryDelayMs(3)).toBe(4 * EPG_ERROR_RETRY_BASE_MS)
    expect(epgRetryDelayMs(99)).toBe(EPG_ERROR_RETRY_MAX_MS)
  })

  it('falls back to the base delay for nonsense input', () => {
    expect(epgRetryDelayMs(0)).toBe(EPG_ERROR_RETRY_BASE_MS)
    expect(epgRetryDelayMs(-3)).toBe(EPG_ERROR_RETRY_BASE_MS)
    expect(epgRetryDelayMs(Number.NaN)).toBe(EPG_ERROR_RETRY_BASE_MS)
  })

  it('retries a failed source after its backoff, reports it honestly while waiting, and recovers', async () => {
    // The reported "stuck provider guide": a cached error entry was served for its whole 6h TTL,
    // so a single failure meant no retry ever happened (its last attempt was hours old) and the
    // screen showed a 'loading' that never resolved.
    const xml = guideXml([{ id: 'r1', displayName: 'Recovered Channel', programmes: [{ startMs: NOW, stopMs: NOW + HOUR, title: 'Back at last' }] }])
    let failing = true
    let hits = 0
    const flaky = await listen((_req, res) => {
      hits++
      if (failing) {
        res.writeHead(500)
        res.end('temporarily unavailable')
        return
      }
      res.writeHead(200, { 'content-type': 'application/xml' })
      res.end(xml)
    })
    const provider = await listen((req, res) => {
      if (req.url?.includes('action=get_live_streams')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify([{ stream_id: 1, name: 'Recovered Channel', epg_channel_id: null }]))
        return
      }
      res.writeHead(404)
      res.end()
    })

    const clock = fakeClock()
    const service = createEpgService({ createUpstreamRequest: createNodeUpstreamRequest, now: clock.now })
    const params = { credentials: { server: provider, username: 'u', password: 'p' }, epgUrls: [flaky] }

    service.peekStatus(params)
    await until(() => service.peekStatus(params)[1].status === 'error')
    const failureStatus = service.peekStatus(params)[1]
    expect(failureStatus.status).toBe('error')
    expect(failureStatus.error).toContain('500')
    const hitsAfterFailure = hits

    // Still within the backoff: polls must neither refetch nor pretend to be loading.
    clock.advance(5_000)
    const duringBackoff = service.peekStatus(params)[1]
    expect(duringBackoff.status).toBe('error')
    expect(hits).toBe(hitsAfterFailure)

    // Backoff elapsed and the source is healthy again: the next poll retries and it recovers.
    failing = false
    clock.advance(EPG_ERROR_RETRY_BASE_MS + 1_000)
    service.peekStatus(params)
    await until(() => service.peekStatus(params)[1].status === 'ok')
    expect(hits).toBeGreaterThan(hitsAfterFailure)
    expect(service.peekStatus(params)[1].channelCount).toBe(1)

    const result = await service.aggregate({ ...params, startMs: NOW, endMs: NOW + HOUR })
    expect(result.listings['1']?.[0]?.title).toBe('Back at last')
  })
})

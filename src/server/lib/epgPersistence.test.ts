import { describe, it, expect, afterEach } from 'vitest'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'
import type { AddressInfo } from 'net'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createEpgService } from './epgService.js'
import { createNodeUpstreamRequest } from './nodeUpstreamRequest.js'

// Two behaviours the operator asked for (2026-09-28) that are only observable end to end:
// a restart must not re-download the guide it already has on disk, and refreshing one source must
// not drag every other source down with it. Both are driven against real local HTTP origins, the
// same discipline epgService.test.ts uses.

const HOUR = 3_600_000
const servers: Server[] = []
const dirs: string[] = []

function xmltvDate(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())} +0000`
}

function guideXml(title: string): string {
  const start = Date.now() - HOUR / 2
  return (
    `<?xml version="1.0"?><tv>` +
    `<channel id="c1"><display-name>Channel One</display-name></channel>` +
    `<programme channel="c1" start="${xmltvDate(start)}" stop="${xmltvDate(start + HOUR)}"><title>${title}</title></programme>` +
    `</tv>`
  )
}

async function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<string> {
  const server = createServer(handler)
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return `http://127.0.0.1:${port}`
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'epg-persist-'))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

async function until(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Condition not met before timeout')
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

/** An origin that answers the provider guide, one external guide, and the channel list. */
async function sportsOrigin(externalPath: string, counters?: { provider: number; external: number }): Promise<string> {
  return listen((req, res) => {
    if (req.url?.startsWith('/xmltv.php')) {
      if (counters) counters.provider += 1
      res.writeHead(200, { 'content-type': 'application/xml' })
      res.end(guideXml('Provider programme'))
      return
    }
    if (req.url === externalPath) {
      if (counters) counters.external += 1
      res.writeHead(200, { 'content-type': 'application/xml' })
      res.end(guideXml('External programme'))
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
}

function window(): { startMs: number; endMs: number } {
  return { startMs: Date.now() - HOUR, endMs: Date.now() + 4 * HOUR }
}

describe('guide persistence across restarts', () => {
  it('reuses the disk copy instead of re-downloading after a restart', async () => {
    const dir = tempDir()
    const counters = { provider: 0, external: 0 }
    const origin = await sportsOrigin('/ext.xml', counters)
    const credentials = { server: origin, username: 'user', password: 'pass' }

    const first = createEpgService({ createUpstreamRequest: createNodeUpstreamRequest, dataDir: dir })
    const result = await first.aggregate({ credentials, epgUrls: [], ...window() })
    expect(result.sources.map((source) => source.status)).toEqual(['ok'])
    expect(counters.provider).toBe(1)

    // A fresh process: the in-memory cache is empty, the disk copy is not. It must not fetch again.
    const restarted = createEpgService({ createUpstreamRequest: createNodeUpstreamRequest, dataDir: dir })
    const afterRestart = await restarted.aggregate({ credentials, epgUrls: [], ...window() })
    expect(afterRestart.sources.map((source) => source.status)).toEqual(['ok'])
    expect(counters.provider).toBe(1)
  })

  it('still fetches when there is no usable disk copy', async () => {
    const counters = { provider: 0, external: 0 }
    const origin = await sportsOrigin('/ext.xml', counters)
    const credentials = { server: origin, username: 'user', password: 'pass' }
    // A data dir that exists but was never written to.
    const service = createEpgService({ createUpstreamRequest: createNodeUpstreamRequest, dataDir: tempDir() })
    await service.aggregate({ credentials, epgUrls: [], ...window() })
    expect(counters.provider).toBe(1)
  })
})

describe('refreshing one source', () => {
  it('refreshes only the named source, leaving the provider guide alone', async () => {
    const counters = { provider: 0, external: 0 }
    const origin = await sportsOrigin('/ext.xml', counters)
    const external = `${origin}/ext.xml`
    const credentials = { server: origin, username: 'user', password: 'pass' }
    const service = createEpgService({ createUpstreamRequest: createNodeUpstreamRequest, dataDir: tempDir() })

    await service.aggregate({ credentials, epgUrls: [external], ...window() })
    expect(counters).toEqual({ provider: 1, external: 1 })

    service.refresh({ credentials, epgUrls: [external], url: external })
    await until(() => counters.external === 2)
    // The provider's 168 MB guide was not re-downloaded to retry a small feed.
    expect(counters.provider).toBe(1)
  })

  it('refreshes everything when no source is named', async () => {
    const counters = { provider: 0, external: 0 }
    const origin = await sportsOrigin('/ext.xml', counters)
    const external = `${origin}/ext.xml`
    const credentials = { server: origin, username: 'user', password: 'pass' }
    const service = createEpgService({ createUpstreamRequest: createNodeUpstreamRequest, dataDir: tempDir() })

    await service.aggregate({ credentials, epgUrls: [external], ...window() })
    service.refresh({ credentials, epgUrls: [external] })
    await until(() => counters.provider === 2 && counters.external === 2)
  })

  it('forgetting a source leaves nothing of it behind', async () => {
    const counters = { provider: 0, external: 0 }
    const origin = await sportsOrigin('/ext.xml', counters)
    const external = `${origin}/ext.xml`
    const credentials = { server: origin, username: 'user', password: 'pass' }
    const service = createEpgService({ createUpstreamRequest: createNodeUpstreamRequest, dataDir: tempDir() })

    await service.aggregate({ credentials, epgUrls: [external], ...window() })
    expect(counters.external).toBe(1)
    service.forget(external)
    // The next look (as the status screen does) sees the source as unknown, not as a stale "ok".
    const status = await service.getStatus({ credentials, epgUrls: [] })
    expect(status[0].status).toBe('ok')
    expect(counters.external).toBe(1)
  })
})

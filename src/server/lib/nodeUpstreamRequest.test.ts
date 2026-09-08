import { describe, it, expect, afterEach } from 'vitest'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'
import { gzipSync } from 'zlib'
import type { AddressInfo } from 'net'
import { createNodeUpstreamRequest } from './nodeUpstreamRequest.js'

// Real usage (proxyServer.ts) always eventually does `req.pipe(upstreamReq)` — for the
// GET/HEAD-only requests this app ever proxies, the incoming client request is already ended
// with an empty body, and piping an already-ended source into a destination calls .end() on
// it as a side effect. There's no real incoming request to pipe here, so this stands in for
// that same "nothing left to write, go ahead and send" signal directly. `end` is deliberately
// not part of UpstreamClientRequest's own type (see that interface's own comment on why) even
// though the real object always has one at runtime — same reason proxyServer.ts itself needs
// an `as unknown as NodeJS.WritableStream` cast to pipe into it.
function endRequest(req: ReturnType<typeof createNodeUpstreamRequest>): void {
  ;(req as unknown as { end: () => void }).end()
}

// Same discipline proxyServer.test.ts already established for the app this was ported from:
// exercise the real Node networking stack via a real local HTTP server, not a hand-shaped fake
// response object — the whole reason this module exists is to stand in for Electron's net
// module correctly, which is exactly the kind of thing a mock could get subtly wrong.

let server: Server | null = null

async function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<string> {
  server = createServer(handler)
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
  const { port } = server!.address() as AddressInfo
  return `http://127.0.0.1:${port}`
}

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()))
    server = null
  }
})

function collect(body: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    body.on('data', (chunk: Buffer) => chunks.push(chunk))
    body.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    body.on('error', reject)
  })
}

describe('createNodeUpstreamRequest', () => {
  it('delivers a plain response with status/headers/body intact', async () => {
    const base = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('hello world')
    })

    const body = await new Promise<string>((resolve, reject) => {
      const req = createNodeUpstreamRequest({ method: 'GET', url: base })
      req.on('response', (res) => {
        expect(res.statusCode).toBe(200)
        expect(res.headers['content-type']).toBe('text/plain')
        collect(res as unknown as NodeJS.ReadableStream).then(resolve, reject)
      })
      req.on('error', reject)
      endRequest(req)
    })

    expect(body).toBe('hello world')
  })

  it('transparently gunzips a gzip-encoded response, matching Electron net.request behavior', async () => {
    const base = await listen((_req, res) => {
      const payload = gzipSync(Buffer.from('compressed payload'))
      res.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'gzip' })
      res.end(payload)
    })

    const body = await new Promise<string>((resolve, reject) => {
      const req = createNodeUpstreamRequest({ method: 'GET', url: base })
      req.on('response', (res) => {
        collect(res as unknown as NodeJS.ReadableStream).then(resolve, reject)
      })
      req.on('error', reject)
      endRequest(req)
    })

    expect(body).toBe('compressed payload')
  })

  it('surfaces a 3xx as a redirect event and only follows it once followRedirect() is called', async () => {
    const base = await listen((req, res) => {
      if (req.url === '/start') {
        res.writeHead(302, { location: '/target' })
        res.end()
      } else {
        res.writeHead(200, { 'content-type': 'text/plain' })
        res.end('final destination')
      }
    })

    const events: string[] = []
    const body = await new Promise<string>((resolve, reject) => {
      const req = createNodeUpstreamRequest({ method: 'GET', url: `${base}/start` })
      req.on('redirect', (statusCode, method, redirectUrl) => {
        events.push(`redirect:${statusCode}:${method}:${redirectUrl}`)
        req.followRedirect()
      })
      req.on('response', (res) => {
        collect(res as unknown as NodeJS.ReadableStream).then(resolve, reject)
      })
      req.on('error', reject)
      endRequest(req)
    })

    expect(events).toEqual([`redirect:302:GET:${base}/target`])
    expect(body).toBe('final destination')
  })

  it('forwards a header set via setHeader to the real upstream request', async () => {
    const received: Record<string, unknown> = {}
    const base = await listen((req, res) => {
      received.range = req.headers.range
      res.writeHead(200)
      res.end()
    })

    await new Promise<void>((resolve, reject) => {
      const req = createNodeUpstreamRequest({ method: 'GET', url: base })
      req.setHeader('range', 'bytes=0-100')
      req.on('response', () => resolve())
      req.on('error', reject)
      endRequest(req)
    })

    expect(received.range).toBe('bytes=0-100')
  })

  it('abort() closes the connection without throwing, even before a response arrives', async () => {
    const base = await listen((_req, res) => {
      // Deliberately never responds — abort() has to work against a request still in flight.
      void res
    })

    const req = createNodeUpstreamRequest({ method: 'GET', url: base })
    // A real caller (proxyServer.ts) always registers this before anything can go wrong — an
    // EventEmitter with no 'error' listener throws synchronously the moment one is emitted,
    // and destroy()ing an in-flight request does emit one (ECONNRESET) shortly afterward.
    req.on('error', () => {})
    expect(() => req.abort()).not.toThrow()
  })
})

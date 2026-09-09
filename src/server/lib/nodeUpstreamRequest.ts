import { EventEmitter } from 'events'
import { request as httpRequest, type ClientRequest, type IncomingMessage } from 'http'
import { request as httpsRequest } from 'https'
import type { Readable } from 'stream'
import { createBrotliDecompress, createGunzip, createInflate } from 'zlib'
import type { UpstreamClientRequest, UpstreamResponse } from './proxyServer.js'

// A live HLS segment/playlist fetch whose connection goes completely silent mid-body — headers
// already arrived, then nothing, socket never actually closes — is otherwise permanent here:
// proxyServer.ts's own upstream timeout only guards the wait for a *first* response (it's
// cleared the moment headers arrive), and plain Node http/https has no equivalent to whatever
// Electron's net module (Chromium's network stack) does about a stalled-but-open connection —
// confirmed via a byte-identical diff against the desktop app's own copy of proxyServer.ts,
// which has never reported this symptom, so the gap is specific to this Node-backed
// replacement, not the shared proxy logic. Left unhandled, this hangs the piped response to the
// browser forever: no error, no close, nothing for hls.js to react to — matching a reported
// live symptom exactly (Live TV plays briefly, then a permanent buffering spinner with no
// console error and no recovery). Handled entirely inside this module's own pipe() below,
// rather than touching proxyServer.ts, to keep that file's parity with the desktop app intact.
const UPSTREAM_STALL_TIMEOUT_MS = 20_000
const UPSTREAM_STALL_CHECK_INTERVAL_MS = 5_000

/**
 * Node https/http-backed replacement for Electron's net.request (see proxyServer.ts's own
 * ProxyServerDeps.createUpstreamRequest doc comment for why Electron used its own net module
 * there — OS-trust-store TLS validation, mainly). Real behavioral gaps that had to be closed
 * to stand in for it correctly, not just superficially:
 *
 * 1. Electron's net module (Chromium's network stack) transparently decompresses gzip/br/
 *    deflate response bodies before proxyServer.ts ever sees them — it only ever strips the
 *    now-stale content-encoding/content-length headers, on the assumption decompression
 *    already happened. Plain Node http/https does NOT decompress automatically, so this
 *    module does it explicitly (based on the real content-encoding header) before handing
 *    bytes to proxyServer.ts, so that assumption still holds true unmodified.
 * 2. Electron's net.request has a "redirect" event you pause on and only follow by calling
 *    followRedirect() explicitly — Node's http/https request has no such thing (a 3xx just
 *    arrives as a normal 'response'). This wraps that manually: a 3xx with a Location header
 *    is intercepted, surfaced as this module's own 'redirect' event, and followRedirect()
 *    issues a brand new request to the target.
 * 3. proxyServer.ts pipes the client's incoming request straight into this object
 *    (`req.pipe(upstreamReq as unknown as NodeJS.WritableStream)`) and separately registers
 *    both a 'response' and an 'error' listener on it — a real EventEmitter is used as the
 *    backing object (rather than hand-rolled single-callback slots) specifically so those two
 *    registrations, plus whatever `.pipe()` itself internally attaches (its own 'error'/
 *    'close' listeners), all coexist correctly instead of silently overwriting each other.
 *
 * TLS trust: unlike Electron, Node ships its own bundled CA list rather than deferring to the
 * OS trust store. On a network with a TLS-inspecting corporate proxy (which installs its own
 * root CA into the OS keychain, not Node's bundled list), this can fail with
 * SELF_SIGNED_CERT_IN_CHAIN even though curl/a real browser trust the connection fine — the
 * exact failure mode proxyServer.ts's own comments describe Electron's net module as having
 * been chosen specifically to avoid. If this server ever needs to run behind such a network,
 * point NODE_EXTRA_CA_CERTS at that corporate root CA rather than disabling TLS verification.
 */
export function createNodeUpstreamRequest(opts: {
  method: string | undefined
  url: string
  // Test-only overrides for UPSTREAM_STALL_TIMEOUT_MS/_CHECK_INTERVAL_MS above — production
  // code never passes these, so real callers always get the real thresholds. Lets
  // nodeUpstreamRequest.test.ts exercise the actual stall-detection path against a real HTTP
  // server without a test needing to wait through the real 20s window.
  stallTimeoutMs?: number
  stallCheckIntervalMs?: number
}): UpstreamClientRequest {
  const stallTimeoutMs = opts.stallTimeoutMs ?? UPSTREAM_STALL_TIMEOUT_MS
  const stallCheckIntervalMs = opts.stallCheckIntervalMs ?? UPSTREAM_STALL_CHECK_INTERVAL_MS
  const emitter = new EventEmitter()
  const pendingHeaders: Record<string, string> = {}
  let currentReq: ClientRequest | null = null
  let pendingRedirectUrl: string | null = null

  function wrapResponse(res: IncomingMessage): UpstreamResponse {
    const encoding = (res.headers['content-encoding'] ?? '').toString().toLowerCase()
    let stream: Readable = res
    if (encoding === 'gzip' || encoding === 'x-gzip') stream = res.pipe(createGunzip())
    else if (encoding === 'deflate') stream = res.pipe(createInflate())
    else if (encoding === 'br') stream = res.pipe(createBrotliDecompress())
    // A corrupt compressed body would otherwise crash the whole process — Node throws on an
    // 'error' event with no listener. Swallowing it here just means the client sees whatever
    // partial bytes already made it through, same as any other mid-stream connection drop.
    if (stream !== res) stream.on('error', () => {})
    const wrappedResponse: UpstreamResponse = {
      statusCode: res.statusCode ?? 0,
      headers: res.headers,
      pipe: (destination) => {
        // See UPSTREAM_STALL_TIMEOUT_MS above. Reset on every chunk actually received; if
        // nothing arrives for the full window, treat the connection as dead — destroying
        // `stream` surfaces as its own 'error' below, which force-ends `destination` (the
        // real client-facing ServerResponse) so the browser's fetch/XHR actually completes
        // (with a failure) instead of hanging indefinitely with no signal at all.
        let lastActivity = Date.now()
        const stallTimer = setInterval(() => {
          if (Date.now() - lastActivity > stallTimeoutMs) {
            stopWatchdog()
            stream.destroy(new Error(`Upstream response stalled for over ${stallTimeoutMs}ms mid-body`))
          }
        }, stallCheckIntervalMs)
        function stopWatchdog(): void {
          clearInterval(stallTimer)
        }
        stream.on('data', () => {
          lastActivity = Date.now()
        })
        stream.on('end', stopWatchdog)
        stream.on('close', stopWatchdog)
        // .pipe() only ever forwards 'data'/'end' from source to destination, never 'error' —
        // without this, a stalled or otherwise broken upstream response leaves `destination`
        // open forever with no more data and no termination.
        stream.on('error', () => {
          stopWatchdog()
          if (!destination.destroyed) destination.destroy()
        })
        stream.pipe(destination)
      },
      on: (event, listener) => {
        stream.on(event, listener)
        return wrappedResponse
      }
    }
    return wrappedResponse
  }

  // Set once the caller signals "no more body coming" (see end() below). A redirect follow
  // issues a brand new underlying request — matching Electron's net.request, the caller
  // (proxyServer.ts) only ever calls .end() once (via piping the client's already-ended
  // request through) on the ORIGINAL object, with no idea a redirect will later swap in a new
  // one underneath it. Without replaying that same "ended" signal onto each new request a
  // redirect creates, every request past the first would sit open forever waiting for a body
  // that was already signaled as complete on a request it never actually applies to.
  let ended = false
  let endArgs: [unknown, unknown, unknown] = [undefined, undefined, undefined]

  function issue(urlStr: string): void {
    const target = new URL(urlStr)
    const requester = target.protocol === 'https:' ? httpsRequest : httpRequest
    const req = requester(urlStr, { method: opts.method ?? 'GET' })
    for (const [name, value] of Object.entries(pendingHeaders)) req.setHeader(name, value)
    req.on('response', (res) => {
      const statusCode = res.statusCode ?? 0
      const location = res.headers.location
      if (statusCode >= 300 && statusCode < 400 && location) {
        pendingRedirectUrl = new URL(location, target).href
        // Drain the redirect body so the connection can close/be reused cleanly — nothing
        // reads it, this is just a Location pointer.
        res.resume()
        emitter.emit('redirect', statusCode, opts.method ?? 'GET', pendingRedirectUrl)
        return
      }
      emitter.emit('response', wrapResponse(res))
    })
    req.on('error', (err) => emitter.emit('error', err))
    currentReq = req
    if (ended) req.end(endArgs[0] as never, endArgs[1] as never, endArgs[2] as never)
  }

  const wrapped = Object.assign(emitter, {
    setHeader(name: string, value: string) {
      pendingHeaders[name] = value
      currentReq?.setHeader(name, value)
    },
    followRedirect() {
      if (!pendingRedirectUrl) return
      const next = pendingRedirectUrl
      pendingRedirectUrl = null
      issue(next)
    },
    abort() {
      currentReq?.destroy()
    },
    // Only ever meaningfully exercised for a GET/HEAD request piping an already-ended, empty
    // client request through (see proxyServer.ts's own comment on this) — Xtream auth is
    // entirely query-string based, this app never proxies a request with a real body.
    write(chunk: unknown, encoding?: unknown, callback?: unknown) {
      return currentReq ? currentReq.write(chunk as never, encoding as never, callback as never) : true
    },
    end(chunk?: unknown, encoding?: unknown, callback?: unknown) {
      ended = true
      endArgs = [chunk, encoding, callback]
      currentReq?.end(chunk as never, encoding as never, callback as never)
      return wrapped
    }
  }) as unknown as UpstreamClientRequest

  issue(opts.url)
  return wrapped
}

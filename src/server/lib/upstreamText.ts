import { Writable } from 'stream'
import { promisify } from 'util'
import { gunzip } from 'zlib'
import type { ServerResponse } from 'http'
import { createNodeUpstreamRequest } from './nodeUpstreamRequest.js'
import type { UpstreamClientRequest } from './proxyServer.js'

// One way to fetch a body as text through the Node upstream machinery: TLS-CA parity with the
// rest of the app, redirect following, the mid-body stall watchdog, and gzip handling. Extracted
// from epgService.ts so the search indexer can use exactly the same path rather than a second
// implementation that drifts.

const MAX_REDIRECTS = 5
const gunzipAsync = promisify(gunzip)

/**
 * Response body → text, transparently handling compression. XMLTV/JSON dumps are commonly served
 * as a pre-compressed `.gz` file (no content-encoding at all), and reading gzip bytes as UTF-8
 * produced binary junk that surfaced as a parser error far from its cause.
 *
 * Sniffed from the bytes rather than trusting content-encoding: the upstream layer already
 * decompresses an encoded response, so acting on the header here would decompress twice.
 */
async function decodeBody(buffer: Buffer): Promise<string> {
  if (buffer.length > 2 && buffer[0] === 0x1f && buffer[1] === 0x8b) {
    try {
      return (await gunzipAsync(buffer)).toString('utf-8')
    } catch (err) {
      throw new Error(`Could not decompress the gzipped response: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return buffer.toString('utf-8')
}

export function fetchTextViaUpstream(
  createUpstreamRequest: typeof createNodeUpstreamRequest = createNodeUpstreamRequest,
  url: string,
  stallTimeoutMs = 60_000,
  stallCheckIntervalMs?: number,
  // Time to wait for response headers. Passed through so a health check can answer promptly
  // instead of inheriting the (deliberately generous) default meant for bulk downloads.
  responseTimeoutMs?: number
): Promise<string> {
  return new Promise((resolve, reject) => {
    const req: UpstreamClientRequest = createUpstreamRequest({
      method: 'GET',
      url,
      stallTimeoutMs,
      stallCheckIntervalMs,
      responseTimeoutMs
    })
    let redirects = 0
    req.on('redirect', () => {
      if (redirects >= MAX_REDIRECTS) {
        req.abort()
        reject(new Error(`Too many redirects fetching ${url}`))
        return
      }
      redirects++
      req.followRedirect()
    })
    req.on('response', (res) => {
      if (res.statusCode >= 400) {
        req.abort()
        reject(new Error(`HTTP ${res.statusCode} fetching ${url}`))
        return
      }
      const chunks: Buffer[] = []
      let settled = false
      const sink = new Writable({
        write(chunk: Buffer, _encoding, callback) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
          callback()
        }
      })
      sink.on('finish', () => {
        if (settled) return
        settled = true
        decodeBody(Buffer.concat(chunks)).then(resolve, reject)
      })
      sink.on('close', () => {
        if (settled) return
        settled = true
        reject(new Error(`Connection closed before the download finished: ${url}`))
      })
      sink.on('error', (err) => {
        if (settled) return
        settled = true
        reject(err)
      })
      res.pipe(sink as unknown as ServerResponse)
    })
    req.on('error', (err) => reject(err instanceof Error ? err : new Error(String(err))))
    ;(req as unknown as { end: () => void }).end()
  })
}

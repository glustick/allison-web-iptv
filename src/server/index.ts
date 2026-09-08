import { existsSync } from 'fs'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { createServer as createHttpServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'http'
import path from 'path'
import { fileURLToPath } from 'url'
import express from 'express'
import { createRequire } from 'module'
import { createProxyServer, type ProxyServerDeps } from './lib/proxyServer.js'
import { createNodeUpstreamRequest } from './lib/nodeUpstreamRequest.js'
import { createTranscodeService } from './lib/transcodeService.js'
import { createFfmpegResolver } from './lib/ffmpegResolver.js'

// ffmpeg-static is a plain CommonJS package with no "exports" map — TypeScript's NodeNext
// module resolution (the correct choice for a real standalone Node server, unlike the
// bundler-based resolution the desktop app's electron-vite build used) can't reliably infer a
// default-export type for it, so this sidesteps that interop guessing entirely via a genuine
// CJS require instead of an ESM import.
const require = createRequire(import.meta.url)
const ffmpegStaticPath = require('ffmpeg-static') as string | null

const execFileAsync = promisify(execFile)
const __dirname = path.dirname(fileURLToPath(import.meta.url))

const PUBLIC_PORT = Number(process.env.PORT ?? 8080)
// Internal-only — never exposed directly; the public Express app relays proxy-shaped requests
// here (see relayToProxy below) so the whole app is reachable through one public port, the way
// a personal self-hosted server actually needs to be (one port to forward through a router/
// reverse proxy), while keeping proxyServer.ts itself completely unmodified from the desktop
// app it was ported from.
const PROXY_INTERNAL_PORT = Number(process.env.PROXY_INTERNAL_PORT ?? 4001)

// --- Xtream/M3U target state --------------------------------------------------------------
// A single global for now, matching the original desktop app's own "one active profile at a
// time" model — this scaffold is proving the ported proxy/transcode logic runs standalone on
// a real Node server first. Making this per-logged-in-session (so more than one household
// member can be connected to a different provider at once) is real, tracked follow-up work —
// see this project's own effort-assessment plan, "de-globalize per-connection state".
let proxyTargetBase: string | null = null

// --- ffmpeg / transcode service ------------------------------------------------------------
// No "prefer a system ffmpeg" reason to skip here the way the desktop app has one (that existed
// purely to avoid shipping a redundant second copy in an installer) — a server just needs one
// ffmpeg, so the bundled one is enough. Still routed through ffmpegResolver so a real, already-
// tested resolution path is being reused rather than re-invented.
const resolveFfmpegPath = createFfmpegResolver(ffmpegStaticPath, {
  platform: process.platform,
  fileExists: existsSync,
  execFile: (execPath, args) => execFileAsync(execPath, args)
})
const transcodeService = createTranscodeService({ resolveFfmpegPath })

// --- Ported proxy server, running on its own internal-only port ---------------------------
const proxyDeps: ProxyServerDeps = {
  getProxyTargetBase: () => proxyTargetBase,
  createUpstreamRequest: createNodeUpstreamRequest,
  // Node has no persistent, clearable DNS cache the way Chromium does (a plain http/https
  // request re-resolves via the OS resolver each time) — nothing to clear.
  clearHostResolverCache: async () => {},
  // No VPN feature in the web version (see the effort-assessment plan — spawning an OS-
  // elevated OpenVPN process and rewriting the machine's own routing table doesn't fit a
  // shared-server model at all). These stubs keep proxyServer.ts's own retry/redirect logic
  // completely unmodified rather than special-casing "no VPN" inside it.
  isVpnConnected: () => false,
  getVpnTunneledHost: () => null,
  onOffTunnelRedirect: () => {},
  getVpnTunneledIp: () => null,
  resolveHostIp: async () => null,
  onTunneledHostIpChanged: () => {},
  handleTranscodeRequest: (url, res) => {
    transcodeService.serveTranscodeFile(url, res).catch((err) => {
      console.error('[transcode] serve error:', err)
      if (!res.headersSent) res.writeHead(500)
      res.end('Transcode serve error')
    })
  }
}
const proxyServer = createProxyServer(proxyDeps)
proxyServer.listen(PROXY_INTERNAL_PORT, '127.0.0.1', () => {
  console.log(`[proxy] internal proxy listening on 127.0.0.1:${PROXY_INTERNAL_PORT}`)
})

// --- Public app: static client + a small API, with proxy-shaped requests relayed inward ---
const app = express()
app.use(express.json())

// Genuinely new work with no desktop-app counterpart at all — the Electron app never needed
// this because Electron's own window was implicitly the one and only "user." Deliberately
// minimal for this scaffold: a single shared secret via env var, not a real account system —
// see the effort-assessment plan's "Add a real login gate" for what a fuller version needs.
app.post('/api/login', (req, res) => {
  const configuredPassword = process.env.ACCESS_PASSWORD
  if (!configuredPassword) {
    res.status(500).json({ error: 'Server has no ACCESS_PASSWORD configured' })
    return
  }
  if (req.body?.password !== configuredPassword) {
    res.status(401).json({ error: 'Incorrect password' })
    return
  }
  res.json({ ok: true })
})

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, name: 'Allison Web IPTV', version: '0.1.0' })
})

// Points the proxy at a (possibly different) Xtream server — the web equivalent of the
// desktop app's own proxy.setTarget IPC call (useAppStore.ts's connect()).
app.post('/api/connect', (req, res) => {
  const server = typeof req.body?.server === 'string' ? req.body.server : null
  if (!server) {
    res.status(400).json({ error: 'Missing "server" in request body' })
    return
  }
  proxyTargetBase = server.trim().replace(/\/+$/, '')
  res.json({ ok: true })
})

// Every request the ported proxy owns — the Xtream-base-relative path, plus its two explicit
// prefixes — gets relayed into the internal proxy server rather than reimplemented here.
function relayToProxy(req: IncomingMessage, res: ServerResponse): void {
  const relay = httpRequest(
    {
      host: '127.0.0.1',
      port: PROXY_INTERNAL_PORT,
      path: req.url,
      method: req.method,
      headers: req.headers
    },
    (relayRes) => {
      res.writeHead(relayRes.statusCode ?? 502, relayRes.headers)
      relayRes.pipe(res)
    }
  )
  relay.on('error', (err) => {
    console.error('[relay] error reaching internal proxy:', err)
    if (!res.headersSent) res.writeHead(502)
    res.end('Could not reach internal proxy')
  })
  req.pipe(relay)
}

app.use((req, res, next) => {
  if (req.path.startsWith('/__fetch/') || req.path.startsWith('/__transcode/') || req.path === '/player_api.php' || req.path === '/xmltv.php' || req.path.startsWith('/live/') || req.path.startsWith('/movie/') || req.path.startsWith('/series/') || req.path.startsWith('/timeshift/')) {
    relayToProxy(req, res)
    return
  }
  next()
})

const publicDir = path.join(__dirname, '..', '..', 'public')
app.use(express.static(publicDir))
app.get('*', (_req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'))
})

createHttpServer(app).listen(PUBLIC_PORT, () => {
  console.log(`[server] Allison Web IPTV listening on http://localhost:${PUBLIC_PORT}`)
})

import { existsSync } from 'fs'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { createServer as createHttpServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'http'
import { randomUUID } from 'crypto'
import path from 'path'
import { fileURLToPath } from 'url'
import express from 'express'
import { createRequire } from 'module'
import { createProxyServer, type ProxyServerDeps } from './lib/proxyServer.js'
import { createNodeUpstreamRequest } from './lib/nodeUpstreamRequest.js'
import { createTranscodeService } from './lib/transcodeService.js'
import { createFfmpegResolver } from './lib/ffmpegResolver.js'
import { getTargetForRequest, normalizeProxyTargetBase, parseCookieValue } from './lib/sessionState.js'
import { decryptSessionCredentials, decryptSessionProfileState, encryptSessionCredentials, encryptSessionProfileState, type SessionCredentials } from './lib/sessionStore.js'
import { compareVersions } from './lib/versionCheck.js'

// ffmpeg-static is a plain CommonJS package with no "exports" map — TypeScript's NodeNext
// module resolution (the correct choice for a real standalone Node server, unlike the
// bundler-based resolution the desktop app's electron-vite build used) can't reliably infer a
// default-export type for it, so this sidesteps that interop guessing entirely via a genuine
// CJS require instead of an ESM import.
const require = createRequire(import.meta.url)
const ffmpegStaticPath = require('ffmpeg-static') as string | null
// Single source of truth for the version reported at /api/health — this used to be a separate
// hardcoded literal here that quietly drifted out of sync with package.json's own version the
// very first time that was bumped without anyone remembering to update this too.
const pkg = require('../../package.json') as { version: string }

const execFileAsync = promisify(execFile)
const __dirname = path.dirname(fileURLToPath(import.meta.url))

const PUBLIC_PORT = Number(process.env.PORT ?? 8085)
// Internal-only — never exposed directly; the public Express app relays proxy-shaped requests
// here (see relayToProxy below) so the whole app is reachable through one public port, the way
// a personal self-hosted server actually needs to be (one port to forward through a router/
// reverse proxy), while keeping proxyServer.ts itself completely unmodified from the desktop
// app it was ported from.
const PROXY_INTERNAL_PORT = Number(process.env.PROXY_INTERNAL_PORT ?? 4001)

// --- Xtream/M3U target state --------------------------------------------------------------
// This is intentionally request-aware and session-aware, not a single process-global target: the
// web app can now serve multiple browser sessions without everyone's requests silently sharing
// the same upstream Xtream base. The app still keeps a default fallback target for older clients
// and for single-user setups, but the actual active target can live on the session cookie.
let defaultProxyTargetBase: string | null = null
const sessionProxyTargets = new Map<string, string>()
const sessionCredentialStore = new Map<string, string>()
const sessionProfileStore = new Map<string, string>()

function getSessionIdFromRequest(req: { headers?: Record<string, string | string[] | undefined> }): string | null {
  const cookieHeader = typeof req.headers?.cookie === 'string' ? req.headers.cookie : undefined
  return parseCookieValue(cookieHeader, 'allison_web_iptv_session')
}

function getProxyTargetBase(req?: IncomingMessage): string | null {
  if (!req) return defaultProxyTargetBase ? normalizeProxyTargetBase(defaultProxyTargetBase) : null
  const target = getTargetForRequest(req.headers, defaultProxyTargetBase, sessionProxyTargets)
  return target ? normalizeProxyTargetBase(target) : null
}

function ensureSessionId(req: IncomingMessage, res: ServerResponse): string {
  const sessionId = getSessionIdFromRequest(req)
  if (sessionId) return sessionId

  const nextSessionId = randomUUID()
  res.setHeader('Set-Cookie', `allison_web_iptv_session=${encodeURIComponent(nextSessionId)}; Path=/; HttpOnly; SameSite=Lax`)
  return nextSessionId
}

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
  getProxyTargetBase: (req?: IncomingMessage) => getProxyTargetBase(req),
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
  res.json({ ok: true, name: 'Allison Web IPTV', version: pkg.version })
})

app.get('/api/version-check', (_req, res) => {
  void (async (): Promise<void> => {
    try {
      const releaseRes = await fetch('https://api.github.com/repos/glustick/allison-web-iptv/releases/latest', {
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'allison-web-iptv'
        }
      })

      if (!releaseRes.ok) {
        res.json({ ok: true, currentVersion: pkg.version, latestVersion: pkg.version, updateAvailable: false })
        return
      }

      const body = (await releaseRes.json()) as { tag_name?: string }
      const latestVersion = body.tag_name ?? pkg.version
      const updateAvailable = compareVersions(pkg.version, latestVersion) < 0
      res.json({ ok: true, currentVersion: pkg.version, latestVersion, updateAvailable })
    } catch {
      res.json({ ok: true, currentVersion: pkg.version, latestVersion: pkg.version, updateAvailable: false })
    }
  })()
})

app.get('/api/session', (req, res) => {
  const sessionId = getSessionIdFromRequest(req)
  if (!sessionId) {
    res.json({ ok: true, sessionId: null, server: null, username: null, password: null, accessPassword: null })
    return
  }

  const stored = sessionCredentialStore.get(sessionId)
  if (!stored) {
    res.json({ ok: true, sessionId, server: null, username: null, password: null, accessPassword: null })
    return
  }

  try {
    const credentials = decryptSessionCredentials(stored)
    res.json({ ok: true, sessionId, ...credentials })
  } catch {
    sessionCredentialStore.delete(sessionId)
    res.json({ ok: true, sessionId, server: null, username: null, password: null, accessPassword: null })
  }
})

app.get('/api/session/profiles', (req, res) => {
  const sessionId = getSessionIdFromRequest(req)
  if (!sessionId) {
    res.json({ ok: true, sessionId: null, activeProfileId: null, profiles: [] })
    return
  }

  const stored = sessionProfileStore.get(sessionId)
  if (!stored) {
    res.json({ ok: true, sessionId, activeProfileId: null, profiles: [] })
    return
  }

  try {
    const state = decryptSessionProfileState(stored)
    res.json({ ok: true, sessionId, ...state })
  } catch {
    sessionProfileStore.delete(sessionId)
    res.json({ ok: true, sessionId, activeProfileId: null, profiles: [] })
  }
})

app.post('/api/session/save', (req, res) => {
  const sessionId = ensureSessionId(req, res)
  const { accessPassword, server, username, password, profileId, profileName } = req.body ?? {}
  const legacyCredentials = { accessPassword, server, username, password }
  if (typeof accessPassword === 'string' && typeof server === 'string' && typeof username === 'string' && typeof password === 'string') {
    const payload: SessionCredentials = { accessPassword, server, username, password }
    sessionCredentialStore.set(sessionId, encryptSessionCredentials(payload))

    const previousProfiles = (() => {
      const saved = sessionProfileStore.get(sessionId)
      if (!saved) return { activeProfileId: null, profiles: [] }
      try {
        return decryptSessionProfileState(saved)
      } catch {
        sessionProfileStore.delete(sessionId)
        return { activeProfileId: null, profiles: [] }
      }
    })()

    const nextProfileId = typeof profileId === 'string' && profileId.trim().length > 0 ? profileId : `profile-${Date.now()}`
    const nextName = typeof profileName === 'string' && profileName.trim().length > 0 ? profileName : username
    const nextProfiles = previousProfiles.profiles.filter((profile) => profile.id !== nextProfileId)
    nextProfiles.push({ id: nextProfileId, name: nextName, credentials: payload })
    const nextState = {
      activeProfileId: previousProfiles.activeProfileId ?? nextProfileId,
      profiles: nextProfiles
    }
    sessionProfileStore.set(sessionId, encryptSessionProfileState(nextState))
    res.json({ ok: true, sessionId, profileId: nextProfileId, profiles: nextState.profiles, activeProfileId: nextState.activeProfileId })
    return
  }

  res.status(400).json({ error: 'Missing session credentials' })
})

app.post('/api/session/profiles', (req, res) => {
  const sessionId = ensureSessionId(req, res)
  const { activeProfileId, profiles } = req.body ?? {}
  if (!Array.isArray(profiles)) {
    res.status(400).json({ error: 'Missing profiles list' })
    return
  }

  const nextState = {
    activeProfileId: typeof activeProfileId === 'string' ? activeProfileId : null,
    profiles: profiles.map((profile) => ({
      id: String(profile?.id ?? `profile-${Date.now()}-${Math.random().toString(16).slice(2)}`),
      name: typeof profile?.name === 'string' ? profile.name : 'Saved profile',
      credentials: {
        accessPassword: String(profile?.credentials?.accessPassword ?? ''),
        server: String(profile?.credentials?.server ?? ''),
        username: String(profile?.credentials?.username ?? ''),
        password: String(profile?.credentials?.password ?? '')
      }
    }))
  }

  sessionProfileStore.set(sessionId, encryptSessionProfileState(nextState))
  res.json({ ok: true, sessionId, ...nextState })
})

app.post('/api/session/clear', (req, res) => {
  const sessionId = getSessionIdFromRequest(req)
  if (sessionId) {
    sessionCredentialStore.delete(sessionId)
  }
  res.clearCookie('allison_web_iptv_session')
  res.json({ ok: true })
})

// Points the proxy at a (possibly different) Xtream server — the web equivalent of the
// desktop app's own proxy.setTarget IPC call (useAppStore.ts's connect()).
app.post('/api/connect', (req, res) => {
  const server = typeof req.body?.server === 'string' ? req.body.server : null
  if (!server) {
    res.status(400).json({ error: 'Missing "server" in request body' })
    return
  }

  const normalizedServer = normalizeProxyTargetBase(server)
  const sessionId = ensureSessionId(req, res)
  sessionProxyTargets.set(sessionId, normalizedServer)
  defaultProxyTargetBase = normalizedServer
  res.json({ ok: true, sessionId })
})

// Resolves a client-relative stream path (e.g. /live/user/pass/123.m3u8, exactly what
// xtreamClient.ts's getStreamUrl() already returns) into the real, absolute upstream URL —
// needed here because ffmpeg (unlike the browser) fetches its source directly over the
// network itself, not through this app's own proxy, so it needs a real reachable URL rather
// than a same-origin relative one. Mirrors the desktop app's own Player.tsx, which passes
// nowPlaying.url (already the raw upstream URL there) straight to transcode:start.
function resolveUpstreamUrl(relativeOrAbsolute: string, req?: IncomingMessage): string {
  const targetBase = getProxyTargetBase(req)
  if (!targetBase) throw new Error('Not connected to an Xtream server')
  return new URL(relativeOrAbsolute, targetBase).href
}

app.post('/api/transcode/start', (req, res) => {
  const { sourceUrl, isVod, sessionId, subtitleStreamIndex, audioStreamIndex } = req.body ?? {}
  if (typeof sourceUrl !== 'string' || typeof sessionId !== 'string') {
    res.status(400).json({ error: 'Missing sourceUrl/sessionId' })
    return
  }
  transcodeService
    .startTranscode(resolveUpstreamUrl(sourceUrl, req), Boolean(isVod), sessionId, subtitleStreamIndex, audioStreamIndex)
    .then(({ playlistPath, subtitleTracks }) => {
      // Same reasoning as the desktop app's own transcode:start handler: the filename varies
      // (playlist.m3u8 normally, master.m3u8 when a subtitle rendition got included), so
      // basename() rather than a hardcoded name is what makes that switch actually reach the
      // player. Relative, same-origin — the public Express app's own relay middleware already
      // forwards anything under /__transcode/ into the internal proxy that serves it.
      res.json({ sessionId, url: `/__transcode/${sessionId}/${path.basename(playlistPath)}`, subtitleTracks })
    })
    .catch((err) => {
      console.error('[transcode] start failed:', err)
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
    })
})

app.post('/api/transcode/stop', (req, res) => {
  const sessionId = req.body?.sessionId
  if (typeof sessionId !== 'string') {
    res.status(400).json({ error: 'Missing sessionId' })
    return
  }
  transcodeService
    .stopTranscode(sessionId)
    .then(() => res.json({ ok: true }))
    .catch((err) => {
      console.error('[transcode] stop failed:', err)
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
    })
})

app.post('/api/transcode/probeTracks', (req, res) => {
  const sourceUrl = req.body?.sourceUrl
  if (typeof sourceUrl !== 'string') {
    res.status(400).json({ error: 'Missing sourceUrl' })
    return
  }
  transcodeService
    .probeTracks(resolveUpstreamUrl(sourceUrl, req))
    .then((tracks) => res.json(tracks))
    .catch((err) => {
      console.error('[transcode] probe failed:', err)
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
    })
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
  console.log(`[server] Allison Web IPTV v${pkg.version} listening on http://localhost:${PUBLIC_PORT}`)
})

// Same reasoning as the desktop app's own 'before-quit' handler: an active transcode session
// is a real ffmpeg child process reading from the account's connection — left running, it
// competes with whatever plays next (fatal on a single-connection account) and just wastes
// CPU/disk otherwise. Confirmed live during this project's own testing: killing this server
// process directly (not through a graceful stop) orphaned exactly one of these, still running
// minutes later with nothing left to serve its output to.
function shutdown(): void {
  transcodeService.stopAll()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

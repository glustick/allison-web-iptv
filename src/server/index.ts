import { existsSync } from 'fs'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { createServer as createHttpServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'http'
import { randomUUID } from 'crypto'
import path from 'path'
import { fileURLToPath } from 'url'
import express, { type Request, type Response, type NextFunction } from 'express'
import { createRequire } from 'module'
import { createProxyServer, type ProxyServerDeps } from './lib/proxyServer.js'
import { createNodeUpstreamRequest } from './lib/nodeUpstreamRequest.js'
import { createTranscodeService } from './lib/transcodeService.js'
import { createFfmpegResolver } from './lib/ffmpegResolver.js'
import { AUTH_COOKIE_NAME, getTargetForRequest, normalizeProxyTargetBase, parseCookieValue } from './lib/sessionState.js'
import { decryptSessionCredentials, encryptSessionCredentials, type SessionCredentials } from './lib/sessionStore.js'
import { createUsersStore, UserStoreError, validatePassword, validateRole, validateUsername, type UserRole } from './lib/usersStore.js'
import { createEpgService, type EpgServiceCredentials } from './lib/epgService.js'
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

// --- Accounts & auth sessions ---------------------------------------------------------------
// The app's own login system: individual accounts (admin/user roles) persisted in a JSON file,
// replacing the old single shared ACCESS_PASSWORD. First launch with zero users puts the
// client into the setup screen that creates the initial admin. Provider (Xtream) credentials
// are NOT asked at login anymore — each account carries its own encrypted IPTV config which is
// checked/applied right after the security check (see the /api/session routes).
const DATA_DIR = process.env.DATA_DIR ?? path.join(__dirname, '..', '..', 'data')
const usersStore = createUsersStore({ filePath: path.join(DATA_DIR, 'users.json') })

export interface NowPlayingInfo {
  title: string
  kind: 'live' | 'movie' | 'series'
}

export interface AuthSession {
  token: string
  username: string
  role: UserRole
  loginAt: number
  lastSeenAt: number
  nowPlaying: NowPlayingInfo | null
}

// Idle timeout: a login survives up to this long without any authenticated request. The
// client's activity heartbeat (every ~15s while playing) keeps streaming sessions alive.
const AUTH_IDLE_TTL_MS = Number(process.env.AUTH_IDLE_TTL_HOURS ?? 24) * 60 * 60 * 1000

const authSessions = new Map<string, AuthSession>()

// Proxy targets keyed by auth-session token (the auth cookie value) — the direct replacement
// for the old anonymous browser-session map. One login = one upstream context.
const sessionProxyTargets = new Map<string, string>()
let defaultProxyTargetBase: string | null = null

declare module 'express-serve-static-core' {
  interface Request {
    authSession?: AuthSession
  }
}

function getAuthSession(req: { headers?: IncomingMessage['headers'] }): AuthSession | null {
  const cookieHeader = typeof req.headers?.cookie === 'string' ? req.headers.cookie : undefined
  const token = parseCookieValue(cookieHeader, AUTH_COOKIE_NAME)
  if (!token) return null
  const session = authSessions.get(token)
  if (!session) return null
  if (Date.now() - session.lastSeenAt > AUTH_IDLE_TTL_MS) {
    authSessions.delete(token)
    return null
  }
  return session
}

function createAuthSession(username: string, role: UserRole): AuthSession {
  const session: AuthSession = {
    token: randomUUID(),
    username,
    role,
    loginAt: Date.now(),
    lastSeenAt: Date.now(),
    nowPlaying: null
  }
  authSessions.set(session.token, session)
  return session
}

function setAuthCookie(res: ServerResponse, token: string): void {
  res.setHeader('Set-Cookie', `${AUTH_COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax`)
}

function clearAuthCookie(res: ServerResponse): void {
  res.setHeader('Set-Cookie', `${AUTH_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`)
}

function destroyAuthSession(token: string): void {
  authSessions.delete(token)
  sessionProxyTargets.delete(token)
}

// Periodic sweep so abandoned sessions (closed tabs, no more heartbeats) don't accumulate
// forever; getAuthSession already lazy-expires on every lookup.
setInterval(() => {
  const now = Date.now()
  for (const [token, session] of authSessions) {
    if (now - session.lastSeenAt > AUTH_IDLE_TTL_MS) destroyAuthSession(token)
  }
}, 10 * 60 * 1000).unref()

function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const session = getAuthSession(req)
  if (!session) {
    res.status(401).json({ error: 'Not logged in' })
    return
  }
  session.lastSeenAt = Date.now()
  req.authSession = session
  next()
}

function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (req.authSession?.role !== 'admin') {
    res.status(403).json({ error: 'Admin access required' })
    return
  }
  next()
}

// --- Xtream/M3U target state --------------------------------------------------------------
// This is intentionally request-aware and login-aware, not a single process-global target: the
// web app can now serve multiple logged-in users without everyone's requests silently sharing
// the same upstream Xtream base. The app still keeps a default fallback target for older
// clients and for single-user setups, but the actual active target lives on the auth session.
function getProxyTargetBase(req?: IncomingMessage): string | null {
  if (!req) return defaultProxyTargetBase ? normalizeProxyTargetBase(defaultProxyTargetBase) : null
  const target = getTargetForRequest(req.headers, defaultProxyTargetBase, sessionProxyTargets)
  return target ? normalizeProxyTargetBase(target) : null
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

// --- EPG aggregation service ----------------------------------------------------------------
// Fetches/caches/merges the provider guide with any extra XMLTV sources configured on the
// account (see the IPTV config screen's "Additional EPG guide URLs") — the server-side
// replacement for the client's old download-98MB-of-XML-per-tab approach, and the home of the
// wider channel→guide matching layer (epgMatching.ts) that recovers channels the exact-id join
// missed.
const epgService = createEpgService()

const MAX_EPG_URLS = 8

function sanitizeEpgUrls(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const urls = value
    .filter((url): url is string => typeof url === 'string' && /^https?:\/\//i.test(url.trim()))
    .map((url) => url.trim())
    .filter((url, index, all) => all.indexOf(url) === index)
    .slice(0, MAX_EPG_URLS)
  return urls.length > 0 ? urls : undefined
}

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

// --- Auth: app-level username/password accounts (replaces the old ACCESS_PASSWORD gate) ----

// Which screen the client should show: first-run setup (no users yet), the login form, or the
// app itself. iptvConfigured tells the client whether the post-login IPTV config step can
// auto-connect or needs to ask for provider details.
app.get('/api/auth/state', (req, res) => {
  try {
    const session = getAuthSession(req)
    if (session) session.lastSeenAt = Date.now()
    const iptvCredentials = session ? usersStore.getIptvCredentials(session.username) : null
    res.json({
      usersExist: usersStore.hasUsers(),
      authenticated: Boolean(session),
      user: session ? { username: session.username, role: session.role } : null,
      iptvConfigured: Boolean(iptvCredentials)
    })
  } catch (err) {
    // Almost always a broken/unreadable users file on the data volume — say so plainly
    // instead of vanishing behind a generic 500 (the client shows this message).
    console.error('[auth] state failed:', err)
    res.status(500).json({ error: `Storage error: ${err instanceof Error ? err.message : String(err)}` })
  }
})

// First-run bootstrap: creates the initial admin account. Only accepted while no users exist
// at all — afterwards account creation goes through the admin panel.
app.post('/api/auth/setup', (req, res) => {
  if (usersStore.hasUsers()) {
    res.status(409).json({ error: 'Setup already completed — log in instead' })
    return
  }
  try {
    const username = validateUsername(req.body?.username)
    const password = validatePassword(req.body?.password)
    const user = usersStore.createUser({ username, password, role: validateRole('admin') })
    usersStore.recordLogin(username)
    const session = createAuthSession(user.username, user.role)
    setAuthCookie(res, session.token)
    res.json({ ok: true, user: { username: user.username, role: user.role } })
  } catch (err) {
    if (err instanceof UserStoreError) {
      res.status(400).json({ error: err.message })
      return
    }
    console.error('[auth] setup failed:', err)
    res.status(500).json({ error: 'Could not create the admin account' })
  }
})

app.post('/api/auth/login', (req, res) => {
  const username = typeof req.body?.username === 'string' ? req.body.username.trim() : ''
  const password = typeof req.body?.password === 'string' ? req.body.password : ''
  if (!username || !password) {
    res.status(400).json({ error: 'Username and password are required' })
    return
  }
  try {
    const user = usersStore.verifyCredentials(username, password)
    if (!user) {
      res.status(401).json({ error: 'Incorrect username or password' })
      return
    }
    // recordLogin writes the users file — on a read-only or full data volume that write is
    // what fails here, so keep the login itself inside this guard rather than letting an
    // uncaught throw turn into an opaque HTML 500.
    usersStore.recordLogin(user.username)
    const session = createAuthSession(user.username, user.role)
    setAuthCookie(res, session.token)
    res.json({ ok: true, user: { username: user.username, role: user.role } })
  } catch (err) {
    console.error('[auth] login failed:', err)
    res.status(500).json({ error: `Storage error: ${err instanceof Error ? err.message : String(err)}` })
  }
})

app.post('/api/auth/logout', (req, res) => {
  const session = getAuthSession(req)
  if (session) destroyAuthSession(session.token)
  clearAuthCookie(res)
  res.json({ ok: true })
})

// Activity heartbeat: keeps the login alive and records what the user is currently streaming
// so the admin console can show it. Sent on playback changes and every ~15s while playing.
app.post('/api/auth/activity', requireAuth, (req, res) => {
  const session = req.authSession as AuthSession
  const nowPlaying = req.body?.nowPlaying
  if (nowPlaying === null || nowPlaying === undefined) {
    session.nowPlaying = null
  } else if (typeof nowPlaying === 'object') {
    const title = typeof nowPlaying.title === 'string' ? nowPlaying.title.slice(0, 200) : ''
    const kind = nowPlaying.kind === 'movie' || nowPlaying.kind === 'series' ? nowPlaying.kind : 'live'
    session.nowPlaying = title ? { title, kind } : null
  }
  res.json({ ok: true })
})

// --- Admin console: who is logged in, what they're watching, and account management --------

app.get('/api/admin/sessions', requireAuth, requireAdmin, (_req, res) => {
  const now = Date.now()
  const sessions = [...authSessions.values()]
    .sort((a, b) => a.loginAt - b.loginAt)
    .map((session) => ({
      token: session.token,
      username: session.username,
      role: session.role,
      loginAt: session.loginAt,
      lastSeenAt: session.lastSeenAt,
      durationMs: now - session.loginAt,
      nowPlaying: session.nowPlaying
    }))
  res.json({ ok: true, sessions })
})

// Force-logout a specific login (e.g. someone left a session playing at home).
app.post('/api/admin/sessions/:token/logout', requireAuth, requireAdmin, (req, res) => {
  const token = typeof req.params.token === 'string' ? req.params.token : ''
  if (!authSessions.has(token)) {
    res.status(404).json({ error: 'Session not found (it may have already ended)' })
    return
  }
  destroyAuthSession(token)
  res.json({ ok: true })
})

app.get('/api/admin/users', requireAuth, requireAdmin, (_req, res) => {
  res.json({ ok: true, users: usersStore.listUsers() })
})

app.post('/api/admin/users', requireAuth, requireAdmin, (req, res) => {
  try {
    const user = usersStore.createUser({
      username: req.body?.username,
      password: req.body?.password,
      role: validateRole(req.body?.role)
    })
    res.json({ ok: true, user })
  } catch (err) {
    if (err instanceof UserStoreError) {
      res.status(400).json({ error: err.message })
      return
    }
    console.error('[admin] create user failed:', err)
    res.status(500).json({ error: 'Could not create the user' })
  }
})

app.delete('/api/admin/users/:username', requireAuth, requireAdmin, (req, res) => {
  const username = typeof req.params.username === 'string' ? req.params.username : ''
  if (username === (req.authSession as AuthSession).username) {
    res.status(400).json({ error: 'You cannot remove the account you are logged in with' })
    return
  }
  try {
    const user = usersStore.deleteUser(username)
    // Drop any live logins belonging to the removed account immediately.
    for (const [token, session] of authSessions) {
      if (session.username === user.username) destroyAuthSession(token)
    }
    res.json({ ok: true, user })
  } catch (err) {
    if (err instanceof UserStoreError) {
      res.status(400).json({ error: err.message })
      return
    }
    console.error('[admin] delete user failed:', err)
    res.status(500).json({ error: 'Could not remove the user' })
  }
})

// --- Post-login IPTV configuration (per account) --------------------------------------------

// Resolves the per-account credentials /api/epg needs (the provider guide is fetched
// server-side with them — the same encrypted store /api/session reads). A login that never
// configured IPTV gets a plain 401 rather than an empty guide.
function resolveEpgCredentials(req: IncomingMessage): (EpgServiceCredentials & { epgUrls: string[] }) | null {
  const cookieHeader = typeof req.headers?.cookie === 'string' ? req.headers.cookie : undefined
  const token = parseCookieValue(cookieHeader, AUTH_COOKIE_NAME)
  if (!token || !authSessions.has(token)) return null
  const session = authSessions.get(token)
  if (!session) return null
  const stored = usersStore.getIptvCredentials(session.username)
  if (!stored) return null
  try {
    const credentials = decryptSessionCredentials(stored)
    return { server: credentials.server, username: credentials.username, password: credentials.password, epgUrls: credentials.epgUrls ?? [] }
  } catch {
    return null
  }
}

// The client's post-login IPTV check: returns the account's saved provider config (including
// the provider password, which the client needs to build stream URLs) or configured:false so
// the UI asks for it.
app.get('/api/session', requireAuth, (req, res) => {
  const session = req.authSession as AuthSession
  const stored = usersStore.getIptvCredentials(session.username)
  if (!stored) {
    res.json({ ok: true, configured: false, server: null, username: null, password: null, epgUrls: [] })
    return
  }
  try {
    const credentials = decryptSessionCredentials(stored)
    res.json({ ok: true, configured: true, ...credentials })
  } catch {
    usersStore.setIptvCredentials(session.username, null)
    res.json({ ok: true, configured: false, server: null, username: null, password: null, epgUrls: [] })
  }
})

app.post('/api/session/save', requireAuth, (req, res) => {
  const session = req.authSession as AuthSession
  const { server, username, password, epgUrls } = req.body ?? {}
  if (typeof server !== 'string' || typeof username !== 'string' || typeof password !== 'string' || !server.trim() || !username.trim() || !password) {
    res.status(400).json({ error: 'Missing IPTV server, username or password' })
    return
  }
  const credentials: SessionCredentials = {
    server: server.trim(),
    username: username.trim(),
    password,
    epgUrls: sanitizeEpgUrls(epgUrls)
  }
  usersStore.setIptvCredentials(session.username, encryptSessionCredentials(credentials))

  // Point the proxy at the provider right away so the client's first Xtream request works
  // without a separate /api/connect round trip.
  const normalizedServer = normalizeProxyTargetBase(credentials.server)
  sessionProxyTargets.set(session.token, normalizedServer)
  defaultProxyTargetBase = normalizedServer
  res.json({ ok: true })
})

app.post('/api/session/clear', requireAuth, (req, res) => {
  const session = req.authSession as AuthSession
  usersStore.setIptvCredentials(session.username, null)
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

// Windowed, aggregated programme listings for the EPG grid — provider guide first, extra
// user-configured XMLTV sources filling channels the provider has nothing for (epgService.ts).
// Clients refetch per time-window navigation; guides themselves are cached server-side per TTL.
app.get('/api/epg', requireAuth, (req, res) => {
  void (async (): Promise<void> => {
    const credentials = resolveEpgCredentials(req)
    if (!credentials) {
      res.status(401).json({ error: 'No IPTV config on this account — finish the IPTV setup first' })
      return
    }
    const startMs = Number(req.query.start)
    const endMs = Number(req.query.end)
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
      res.status(400).json({ error: 'Missing or invalid start/end (epoch milliseconds)' })
      return
    }
    try {
      const window = await epgService.aggregate({ credentials, epgUrls: credentials.epgUrls, startMs, endMs })
      res.json({ ok: true, ...window })
    } catch (err) {
      console.error('[epg] aggregate failed:', err)
      res.status(502).json({ error: err instanceof Error ? err.message : 'EPG aggregation failed' })
    }
  })()
})

// Per-source health of the aggregated guide — a verification/ops surface for "is the provider
// guide actually loading, and did my extra URLs work", deliberately separate from /api/epg so a
// status poll never pays for windowed listings.
app.get('/api/epg/status', requireAuth, (req, res) => {
  void (async (): Promise<void> => {
    const credentials = resolveEpgCredentials(req)
    if (!credentials) {
      res.status(401).json({ error: 'No IPTV config on this account — finish the IPTV setup first' })
      return
    }
    try {
      const sources = await epgService.getStatus({ credentials, epgUrls: credentials.epgUrls })
      res.json({ ok: true, sources })
    } catch (err) {
      console.error('[epg] status failed:', err)
      res.status(502).json({ error: err instanceof Error ? err.message : 'EPG status failed' })
    }
  })()
})

// Points the proxy at a (possibly different) Xtream server — the web equivalent of the
// desktop app's own proxy.setTarget IPC call (useAppStore.ts's connect()).
app.post('/api/connect', requireAuth, (req, res) => {
  const server = typeof req.body?.server === 'string' ? req.body.server : null
  if (!server) {
    res.status(400).json({ error: 'Missing "server" in request body' })
    return
  }

  const session = req.authSession as AuthSession
  const normalizedServer = normalizeProxyTargetBase(server)
  sessionProxyTargets.set(session.token, normalizedServer)
  defaultProxyTargetBase = normalizedServer
  res.json({ ok: true })
})

// Resolves a client-relative stream path (e.g. /live/user/pass/123.m3u8, exactly what
// xtreamClient.ts's getStreamUrl() already returns) into the real, absolute upstream URL —
// needed here because ffmpeg (unlike the browser) fetches its source directly over the
// network itself, not through this app's own proxy, so it needs a real reachable URL rather
// than a same-origin relative one. Mirrors the desktop app's own Player.tsx, which passes
// nowPlaying.url (already the raw upstream URL there) straight to transcode:start.
function resolveUpstreamUrl(relativeOrAbsolute: string, req: Request): string {
  const targetBase = getProxyTargetBase(req)
  if (!targetBase) throw new Error('Not connected to an IPTV server')
  return new URL(relativeOrAbsolute, targetBase).href
}

app.post('/api/transcode/start', requireAuth, (req, res) => {
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

app.post('/api/transcode/stop', requireAuth, (req, res) => {
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

app.post('/api/transcode/probeTracks', requireAuth, (req, res) => {
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
// Gated behind requireAuth so provider streams/API are never reachable without a login.
app.use((req, res, next) => {
  if (req.path.startsWith('/__fetch/') || req.path.startsWith('/__transcode/') || req.path === '/player_api.php' || req.path === '/xmltv.php' || req.path.startsWith('/live/') || req.path.startsWith('/movie/') || req.path.startsWith('/series/') || req.path.startsWith('/timeshift/')) {
    requireAuth(req, res, () => {
      relayToProxy(req as IncomingMessage, res as ServerResponse)
    })
    return
  }
  next()
})

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

const publicDir = path.join(__dirname, '..', '..', 'public')
app.use(express.static(publicDir))
app.get('*', (_req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'))
})

createHttpServer(app).listen(PUBLIC_PORT, () => {
  console.log(`[server] Allison Web IPTV v${pkg.version} listening on http://localhost:${PUBLIC_PORT}`)
  console.log(`[setup] Accounts file: ${path.join(DATA_DIR, 'users.json')} (DATA_DIR=${DATA_DIR})`)
  // Diagnostics must never take the server down: an unreadable users file still lets the API
  // answer with a real, visible error instead of exiting into a restart loop.
  const health = usersStore.healthCheck()
  if (!health.ok) {
    console.error(`[setup] Data directory is NOT usable: ${health.error}`)
    console.error('[setup] Check that DATA_DIR is mounted read-write (docker-compose: ./appdata:/appdata:rw) and that users.json is valid JSON.')
  } else {
    try {
      if (!usersStore.hasUsers()) {
        console.log('[setup] No user accounts yet — open the app to create the initial admin account')
      }
    } catch (err) {
      console.error(`[setup] Could not read user accounts: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
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

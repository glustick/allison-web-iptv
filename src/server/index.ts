import { existsSync, rmSync, writeFileSync } from 'fs'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { createServer as createHttpServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'http'
import { randomUUID } from 'crypto'
import path from 'path'
import { fileURLToPath } from 'url'
import express, { type Request, type Response, type NextFunction } from 'express'
import { createRequire } from 'module'
import { createProxyServer, type ProxyServerDeps } from './lib/proxyServer.js'
import { fetchTextViaUpstream } from './lib/upstreamText.js'
import { createNodeUpstreamRequest } from './lib/nodeUpstreamRequest.js'
import { createTranscodeService, prepareTranscodeDir, resolveTranscodeDir } from './lib/transcodeService.js'
import { createFfmpegResolver } from './lib/ffmpegResolver.js'
import { AUTH_COOKIE_NAME, getTargetForRequest, normalizeProxyTargetBase, parseCookieValue } from './lib/sessionState.js'
import { decryptSessionCredentials, encryptSessionCredentials, type SessionCredentials } from './lib/sessionStore.js'
import { createUsersStore, UserStoreError, validatePassword, validateRole, validateUsername, type UserRole } from './lib/usersStore.js'
import { createEpgService, type EpgServiceCredentials } from './lib/epgService.js'
import { createPrefsStore, PrefsError } from './lib/prefsStore.js'
import { createSearchService } from './lib/searchService.js'
import { captureErrors, recentErrors, fileStats, formatBytes } from './lib/diagnostics.js'
import { createRateLimiter } from './lib/rateLimit.js'
import { assertSafeExternalUrl, isSameOrigin, isSecureRequest, securityHeaders, UnsafeUrlError } from './lib/security.js'
import {
  applyPendingRestore,
  backupDatabase,
  dailyBackup,
  listBackups,
  pendingRestorePath,
  validateDatabaseFile
} from './lib/backup.js'
import { openDatabase } from './lib/db.js'
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

// Before anything opens the database: apply a restore that was uploaded through the admin panel,
// and take the once-a-day snapshot. Both have to happen ahead of the stores below.
captureErrors()
const restoreOutcome = applyPendingRestore(DATA_DIR)
if (restoreOutcome.applied) console.log('[backup] applied an uploaded database restore')
if (restoreOutcome.message) console.error(`[backup] ${restoreOutcome.message}`)
const snapshot = dailyBackup(DATA_DIR)
if (snapshot.created) console.log(`[backup] daily snapshot written to ${snapshot.path}`)
if (snapshot.error) console.error(`[backup] daily snapshot failed: ${snapshot.error}`)
const usersStore = createUsersStore({ dataDir: DATA_DIR })

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

// `Secure` is applied when the request actually arrived over TLS rather than unconditionally:
// the app is legitimately reached both ways (https:// through the reverse proxy, http:// on the
// LAN), and an unconditional Secure flag would break LAN sign-in outright.
function setAuthCookie(res: ServerResponse, token: string, secure: boolean): void {
  res.setHeader(
    'Set-Cookie',
    `${AUTH_COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`
  )
}

function clearAuthCookie(res: ServerResponse, secure: boolean): void {
  res.setHeader(
    'Set-Cookie',
    `${AUTH_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`
  )
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

// SESSION_SECRET encrypts every account's stored IPTV credentials; a missing or too-short
// value is a deployment mistake worth shouting about at boot (it used to surface only as an
// opaque 500 the first time someone saved their IPTV config).
function checkSessionSecret(): string | null {
  const secret = process.env.SESSION_SECRET
  if (!secret || secret.trim().length < 16) {
    return 'SESSION_SECRET is missing or shorter than 16 characters.'
  }
  return null
}

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
  if (target) return normalizeProxyTargetBase(target)

  // Fall back to the account's own saved provider. Without this, a session that never POSTed
  // /api/connect — a fresh login, a reloaded player, or any request after a server restart —
  // had no per-session target and every stream request failed with "No upstream Xtream server
  // configured" (502). Found live: the provider was healthy and answered fine directly while
  // the app rejected its own player's playlist requests, which the player could only retry
  // silently — the "freezes and never recovers" report. The resolved target is cached on the
  // session so the lookup happens once.
  const session = getAuthSession(req)
  if (!session) return null
  const stored = usersStore.getIptvCredentials(session.username)
  if (!stored) return null
  try {
    const credentials = decryptSessionCredentials(stored)
    const normalized = normalizeProxyTargetBase(credentials.server)
    sessionProxyTargets.set(session.token, normalized)
    return normalized
  } catch {
    return null
  }
}

// --- ffmpeg / transcode service ------------------------------------------------------------
// Routed through ffmpegResolver (a real, already-tested resolution path reused rather than
// re-invented). The preferred system ffmpeg is not optional decoration here: the bundled
// ffmpeg-static Linux binary is a static-glibc build that cannot resolve ANY hostname, so
// transcoding network sources only works when a real, dynamically-linked ffmpeg is installed
// (the Dockerfile does exactly that).
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

// Behind a reverse proxy (Docker port mapping, Synology's proxy) the real client address and the
// original scheme arrive in X-Forwarded-*. Trusting those headers only from private/loopback
// sources avoids the spoofing problem of trusting them unconditionally, while still letting the
// login throttle see distinct clients and letting cookies know they arrived over TLS.
// TRUST_PROXY=false turns it off for a directly-exposed deployment.
app.set('trust proxy', process.env.TRUST_PROXY === 'false' ? false : ['loopback', 'linklocal', 'uniquelocal'])
app.use((req, res, next) => {
  securityHeaders(req, res)
  next()
})
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
  try {
    // Inside the try deliberately: with an unusable database this throws, and it used to be the
    // one call site no handler covered — so a broken deployment answered this endpoint with
    // Express's default HTML error page instead of the JSON the rest of the API returns.
    if (usersStore.hasUsers()) {
      res.status(409).json({ error: 'Setup already completed — log in instead' })
      return
    }
    const username = validateUsername(req.body?.username)
    const password = validatePassword(req.body?.password)
    const user = usersStore.createUser({ username, password, role: validateRole('admin') })
    usersStore.recordLogin(username)
    const session = createAuthSession(user.username, user.role)
    setAuthCookie(res, session.token, isSecureRequest(req))
    res.json({ ok: true, user: { username: user.username, role: user.role } })
  } catch (err) {
    if (err instanceof UserStoreError && !err.storageUnavailable) {
      res.status(400).json({ error: err.message })
      return
    }
    // Usually a data-volume problem (read-only mount, permissions, full disk) — carry the
    // real cause through so the setup screen can show it instead of a generic failure.
    console.error('[auth] setup failed:', err)
    res.status(500).json({ error: `Storage error: ${err instanceof Error ? err.message : String(err)}` })
  }
})

// Sign-in throttling: one key per caller address and one per account, because "one host trying
// many accounts" and "many hosts trying one account" are different attacks.
const loginLimiter = createRateLimiter()

app.post('/api/auth/login', (req, res) => {
  const username = typeof req.body?.username === 'string' ? req.body.username.trim() : ''
  const password = typeof req.body?.password === 'string' ? req.body.password : ''
  if (!username || !password) {
    res.status(400).json({ error: 'Username and password are required' })
    return
  }
  const throttleKeys = [`ip:${req.ip ?? req.socket.remoteAddress ?? 'unknown'}`, `user:${username.toLowerCase()}`]
  const blocked = throttleKeys.map((key) => loginLimiter.check(key)).filter((decision) => !decision.allowed)
  if (blocked.length > 0) {
    const retryAfter = Math.max(...blocked.map((decision) => decision.retryAfterSeconds ?? 60))
    res.setHeader('Retry-After', String(retryAfter))
    res.status(429).json({
      error: `Too many failed sign-in attempts. Try again in ${Math.max(1, Math.ceil(retryAfter / 60))} minute(s).`
    })
    return
  }
  try {
    const user = usersStore.verifyCredentials(username, password)
    if (!user) {
      for (const key of throttleKeys) loginLimiter.recordFailure(key)
      res.status(401).json({ error: 'Incorrect username or password' })
      return
    }
    for (const key of throttleKeys) loginLimiter.recordSuccess(key)
    // recordLogin writes the users file — on a read-only or full data volume that write is
    // what fails here, so keep the login itself inside this guard rather than letting an
    // uncaught throw turn into an opaque HTML 500.
    usersStore.recordLogin(user.username)
    const session = createAuthSession(user.username, user.role)
    setAuthCookie(res, session.token, isSecureRequest(req))
    res.json({ ok: true, user: { username: user.username, role: user.role } })
  } catch (err) {
    console.error('[auth] login failed:', err)
    res.status(500).json({ error: `Storage error: ${err instanceof Error ? err.message : String(err)}` })
  }
})

app.post('/api/auth/logout', (req, res) => {
  const session = getAuthSession(req)
  if (session) destroyAuthSession(session.token)
  clearAuthCookie(res, isSecureRequest(req))
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
    if (err instanceof UserStoreError && !err.storageUnavailable) {
      res.status(400).json({ error: err.message })
      return
    }
    console.error('[admin] create user failed:', err)
    res.status(500).json({ error: 'Could not create the user' })
  }
})

// Admin password reset. There was previously no way to change a password after an account was
// created — a typo (or an autocapitalised/trailing-space value captured by the browser) locked
// that account out permanently, with delete-and-recreate as the only remedy.
app.post('/api/admin/users/:username/password', requireAuth, requireAdmin, (req, res) => {
  const username = typeof req.params.username === 'string' ? req.params.username : ''
  try {
    usersStore.setPassword(username, req.body?.password)
    res.json({ ok: true, username })
  } catch (err) {
    if (err instanceof UserStoreError && !err.storageUnavailable) {
      res.status(400).json({ error: err.message })
      return
    }
    console.error('[admin] set password failed:', err)
    res.status(500).json({ error: `Storage error: ${err instanceof Error ? err.message : String(err)}` })
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
    if (err instanceof UserStoreError && !err.storageUnavailable) {
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
  try {
    const stored = usersStore.getIptvCredentials(session.username)
    if (!stored) {
      res.json({ ok: true, configured: false, server: null, username: null, password: null, epgUrls: [] })
      return
    }
    const credentials = decryptSessionCredentials(stored)
    res.json({ ok: true, configured: true, ...credentials })
  } catch (err) {
    // A stored config that no longer decrypts (SESSION_SECRET changed) or an unreadable
    // store is treated as "not configured" so the user can re-enter it — but the reason is
    // still logged rather than swallowed.
    console.error('[session] load failed:', err)
    try {
      usersStore.setIptvCredentials(session.username, null)
    } catch {
      // Store itself unreadable — the response below still lets the client continue.
    }
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
  try {
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
  } catch (err) {
    // Encryption needs a valid SESSION_SECRET and the account store needs a writable data
    // volume — both failures must name themselves here rather than becoming an HTML 500.
    console.error('[session] save failed:', err)
    res.status(500).json({ error: `Storage error: ${err instanceof Error ? err.message : String(err)}` })
  }
})

app.post('/api/session/clear', requireAuth, (req, res) => {
  const session = req.authSession as AuthSession
  try {
    usersStore.setIptvCredentials(session.username, null)
    res.json({ ok: true })
  } catch (err) {
    console.error('[session] clear failed:', err)
    res.status(500).json({ error: `Storage error: ${err instanceof Error ? err.message : String(err)}` })
  }
})

app.get('/api/health', (_req, res) => {
  // `ok` stays true whenever the HTTP server is answering — this endpoint is also what the
  // Docker HEALTHCHECK treats as liveness. `degraded` is the honest signal that the process is up
  // but it cannot reach its own database (so sign-in and every write will fail): someone watching
  // from outside, with no session and therefore no System tab, can still see the difference.
  const db = usersStore.status()
  res.json({ ok: true, name: 'Allison Web IPTV', version: pkg.version, degraded: !db.ok, database: { ok: db.ok, ...(db.error ? { error: db.error } : {}) } })
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

// -- Health & diagnostics --------------------------------------------------------------------

// Cached briefly: the health page polls, and hammering the provider's auth endpoint on every
// poll would be rude (and slow).
let providerProbeCache: { at: number; value: Record<string, unknown> } | null = null

async function probeProvider(credentials: SessionCredentials): Promise<Record<string, unknown>> {
  if (providerProbeCache && Date.now() - providerProbeCache.at < 30_000) return providerProbeCache.value
  const base = credentials.server.trim().replace(/\/+$/, '')
  const url = `${base}/player_api.php?username=${encodeURIComponent(credentials.username)}&password=${encodeURIComponent(
    credentials.password
  )}`
  let value: Record<string, unknown>
  try {
    const body = await fetchTextViaUpstream(undefined, url, 10_000)
    const parsed = JSON.parse(body) as { user_info?: Record<string, unknown> }
    const info = parsed.user_info ?? {}
    value = {
      reachable: true,
      auth: info.auth,
      status: info.status,
      activeConnections: info.active_cons,
      maxConnections: info.max_connections,
      expiresAt: info.exp_date
    }
  } catch (err) {
    value = { reachable: false, error: err instanceof Error ? err.message : String(err) }
  }
  providerProbeCache = { at: Date.now(), value }
  return value
}

app.get('/api/admin/health', requireAuth, requireAdmin, (req, res) => {
  void (async (): Promise<void> => {
    const session = req.authSession as AuthSession
    try {
      const databasePath = path.join(DATA_DIR, 'allison.db')
      const db = openDatabase(DATA_DIR)
      const count = (table: string): number =>
        (db.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count
      const counts = {
        users: count('users'),
        favourites: count('favourites'),
        history: count('history'),
        customCategories: count('custom_categories'),
        customCategoryChannels: count('custom_category_channels'),
        resumePositions: count('resume_positions'),
        searchIndexed: count('search_index')
      }
      db.close()

      // Guide status is read without blocking: peekStatus never waits on a download.
      let guide: unknown = null
      const credentials = resolveAccountCredentials(session.username)
      if (credentials) {
        try {
          guide = epgService.peekStatus({ credentials, epgUrls: credentials.epgUrls ?? [] })
        } catch (err) {
          guide = { error: err instanceof Error ? err.message : String(err) }
        }
      }

      const memory = process.memoryUsage()
      res.json({
        ok: true,
        server: {
          version: pkg.version,
          uptimeSeconds: Math.round(process.uptime()),
          node: process.version,
          platform: `${process.platform}/${process.arch}`,
          memoryMb: Math.round(memory.rss / (1024 * 1024))
        },
        database: {
          // Re-probed per request (it is a single indexed write): SQLite decides whether it can
          // write when it *opens* the file, so a data directory whose ownership is repaired while
          // the server is running keeps a read-only connection until the process reopens it. That
          // showed up in production as a sign-in 500 with nothing on the System page to explain
          // it — the boot check had already run and passed or failed once, and then said nothing.
          ...usersStore.healthCheck(),
          ...fileStats(databasePath),
          sizeLabel: formatBytes(fileStats(databasePath).bytes),
          wal: fileStats(`${databasePath}-wal`),
          counts
        },
        guide,
        transcode: {
          active: await transcodeService.stats(),
          storage: await transcodeService.storage()
        },
        search: searchService.status(),
        security: {
          loginThrottleKeys: loginLimiter.size(),
          trustProxy: app.get('trust proxy') !== false,
          secureRequest: isSecureRequest(req)
        },
        provider: credentials ? await probeProvider(credentials) : { configured: false },
        backups: listBackups(DATA_DIR),
        errors: recentErrors(20)
      })
    } catch (err) {
      console.error('[health] failed:', err)
      res.status(500).json({ error: `Could not read health: ${err instanceof Error ? err.message : String(err)}` })
    }
  })()
})

// -- Backup & restore ------------------------------------------------------------------------

app.get('/api/admin/backup', requireAuth, requireAdmin, (req, res) => {
  void (async (): Promise<void> => {
    const tempPath = path.join(DATA_DIR, 'allison-backup-export.db')
    try {
      await backupDatabase(DATA_DIR, tempPath)
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
      res.download(tempPath, `allison-backup-${stamp}.db`, (err) => {
        // The file is a full copy of every account and credential, so it does not linger.
        try {
          rmSync(tempPath, { force: true })
        } catch {
          /* best effort */
        }
        if (err && !res.headersSent) res.status(500).end()
      })
    } catch (err) {
      console.error('[backup] export failed:', err)
      try {
        rmSync(tempPath, { force: true })
      } catch {
        /* best effort */
      }
      res.status(500).json({ error: `Could not create the backup: ${err instanceof Error ? err.message : String(err)}` })
    }
  })()
})

// Raw body on purpose: this is a database file, not JSON. Capped well above a realistic database
// size so a runaway upload can't fill the disk.
app.post(
  '/api/admin/restore',
  requireAuth,
  requireAdmin,
  express.raw({ type: '*/*', limit: '512mb' }),
  (req, res) => {
    try {
      const body = req.body as Buffer
      if (!Buffer.isBuffer(body) || body.length === 0) {
        res.status(400).json({ error: 'No file content received' })
        return
      }
      const pending = pendingRestorePath(DATA_DIR)
      writeFileSync(pending, body)
      const check = validateDatabaseFile(pending)
      if (!check.ok) {
        rmSync(pending, { force: true })
        res.status(400).json({ error: `That file is not a usable backup: ${check.error}` })
        return
      }
      res.json({ ok: true, requiresRestart: true })
    } catch (err) {
      console.error('[backup] restore upload failed:', err)
      res.status(500).json({ error: `Could not stage the restore: ${err instanceof Error ? err.message : String(err)}` })
    }
  }
)

// -- Search over the provider's catalogue ----------------------------------------------------
// Indexed in SQLite: instant after the first build, and still answering when the provider is
// unreachable (which is exactly when a cached index earns its keep).
const searchService = createSearchService({ dataDir: DATA_DIR })

app.get('/api/search', requireAuth, (req, res) => {
  const session = req.authSession as AuthSession
  const query = typeof req.query.q === 'string' ? req.query.q : ''
  try {
    const limit = Number(req.query.limit ?? 40)
    const kind = typeof req.query.kind === 'string' && ['live', 'movie', 'series'].includes(req.query.kind)
      ? (req.query.kind as 'live' | 'movie' | 'series')
      : undefined
    const hits = query.trim().length === 0 ? [] : searchService.search(query, Number.isFinite(limit) ? limit : 40, kind)
    // Keep the index warm in the background; a search never waits on a rebuild.
    const credentials = resolveAccountCredentials(session.username)
    if (credentials) searchService.ensureFresh(credentials)
    res.json({ ok: true, query, hits, index: searchService.status() })
  } catch (err) {
    console.error('[search] failed:', err)
    res.status(500).json({ error: `Search failed: ${err instanceof Error ? err.message : String(err)}` })
  }
})

app.get('/api/search/status', requireAuth, (req, res) => {
  const session = req.authSession as AuthSession
  try {
    const credentials = resolveAccountCredentials(session.username)
    if (credentials) searchService.ensureFresh(credentials)
    res.json({ ok: true, index: searchService.status() })
  } catch (err) {
    console.error('[search] status failed:', err)
    res.status(500).json({ error: `Could not read the index status: ${err instanceof Error ? err.message : String(err)}` })
  }
})

// Admin-only: a manual rebuild pulls the provider's entire catalogue (live + VOD + series), so
// it is not something any signed-in user should be able to trigger at will.
app.post('/api/search/reindex', requireAuth, requireAdmin, (req, res) => {
  void (async (): Promise<void> => {
    const session = req.authSession as AuthSession
    try {
      const credentials = resolveAccountCredentials(session.username)
      if (!credentials) {
        res.status(409).json({ error: 'No IPTV config on this account — finish the IPTV setup first' })
        return
      }
      const index = await searchService.rebuild(credentials)
      res.json({ ok: true, index })
    } catch (err) {
      console.error('[search] reindex failed:', err)
      res.status(500).json({ error: `Could not rebuild the index: ${err instanceof Error ? err.message : String(err)}` })
    }
  })()
})

// -- Per-user library: favourites, watch history, custom categories --------------------------
// Same SQLite database as the accounts (see db.ts), which is what makes all of it survive an
// image update: it lives under DATA_DIR (/appdata in Docker) alongside everything else.

const prefsStore = createPrefsStore({ dataDir: DATA_DIR })

/** Shared error shape for the prefs routes: validation problems are the client's fault (400),
 *  anything else is storage (500) and carries its real message. */
function handlePrefsError(res: Response, err: unknown, what: string): void {
  if (err instanceof PrefsError) {
    res.status(400).json({ error: err.message })
    return
  }
  console.error(`[prefs] ${what} failed:`, err)
  res.status(500).json({ error: `Storage error: ${err instanceof Error ? err.message : String(err)}` })
}

// Everything the sidebar needs in one request: favourites, custom categories and recent history.
app.get('/api/prefs', requireAuth, (req, res) => {
  const session = req.authSession as AuthSession
  try {
    res.json({
      ok: true,
      favourites: prefsStore.listFavourites(session.username),
      categories: prefsStore.listCategories(session.username),
      history: prefsStore.listHistory(session.username, 50),
      resume: prefsStore.listResumePositions(session.username)
    })
  } catch (err) {
    handlePrefsError(res, err, 'load')
  }
})

app.post('/api/prefs/favourites', requireAuth, (req, res) => {
  const session = req.authSession as AuthSession
  try {
    prefsStore.setFavourite(session.username, req.body ?? {}, Boolean(req.body?.favourite))
    res.json({ ok: true, favourites: prefsStore.listFavourites(session.username) })
  } catch (err) {
    handlePrefsError(res, err, 'set favourite')
  }
})

// Drag-and-drop ordering. Both routes take the full desired order rather than a from/to pair:
// the client already knows the final arrangement, and a full list is idempotent — a retry after
// a dropped connection can't scramble anything.
app.post('/api/prefs/favourites/order', requireAuth, (req, res) => {
  const session = req.authSession as AuthSession
  try {
    prefsStore.setFavouriteOrder(session.username, req.body?.order ?? [])
    res.json({ ok: true, favourites: prefsStore.listFavourites(session.username) })
  } catch (err) {
    handlePrefsError(res, err, 'reorder favourites')
  }
})

app.post('/api/prefs/categories/:id/order', requireAuth, (req, res) => {
  const session = req.authSession as AuthSession
  try {
    prefsStore.reorderCategoryChannels(session.username, Number(req.params.id), req.body?.order ?? [])
    res.json({ ok: true, categories: prefsStore.listCategories(session.username) })
  } catch (err) {
    handlePrefsError(res, err, 'reorder category')
  }
})

app.get('/api/prefs/history', requireAuth, (req, res) => {
  const session = req.authSession as AuthSession
  try {
    const limit = Number(req.query.limit ?? 100)
    res.json({ ok: true, history: prefsStore.listHistory(session.username, Number.isFinite(limit) ? limit : 100) })
  } catch (err) {
    handlePrefsError(res, err, 'history')
  }
})

app.post('/api/prefs/history', requireAuth, (req, res) => {
  const session = req.authSession as AuthSession
  try {
    prefsStore.recordHistory(session.username, req.body ?? {})
    res.json({ ok: true })
  } catch (err) {
    handlePrefsError(res, err, 'record history')
  }
})

app.delete('/api/prefs/history', requireAuth, (req, res) => {
  const session = req.authSession as AuthSession
  try {
    prefsStore.clearHistory(session.username)
    res.json({ ok: true, history: [] })
  } catch (err) {
    handlePrefsError(res, err, 'clear history')
  }
})

// Resume points for movies and series (never live — the store rejects it).
app.get('/api/prefs/resume', requireAuth, (req, res) => {
  const session = req.authSession as AuthSession
  try {
    const kind = typeof req.query.kind === 'string' ? (req.query.kind as 'movie' | 'series') : undefined
    res.json({ ok: true, resume: prefsStore.listResumePositions(session.username, kind) })
  } catch (err) {
    handlePrefsError(res, err, 'resume positions')
  }
})

app.post('/api/prefs/resume', requireAuth, (req, res) => {
  const session = req.authSession as AuthSession
  try {
    const position = prefsStore.setResumePosition(
      session.username,
      req.body ?? {},
      Number(req.body?.positionSeconds),
      req.body?.durationSeconds === undefined || req.body?.durationSeconds === null ? null : Number(req.body.durationSeconds)
    )
    res.json({ ok: true, resume: position, resumePositions: prefsStore.listResumePositions(session.username) })
  } catch (err) {
    handlePrefsError(res, err, 'save resume position')
  }
})

app.delete('/api/prefs/resume/:kind/:streamId', requireAuth, (req, res) => {
  const session = req.authSession as AuthSession
  try {
    prefsStore.clearResumePosition(
      session.username,
      String(req.params.kind) as 'movie' | 'series',
      Number(req.params.streamId)
    )
    res.json({ ok: true, resumePositions: prefsStore.listResumePositions(session.username) })
  } catch (err) {
    handlePrefsError(res, err, 'clear resume position')
  }
})

app.post('/api/prefs/categories', requireAuth, (req, res) => {
  const session = req.authSession as AuthSession
  try {
    const category = prefsStore.createCategory(session.username, req.body?.name)
    res.json({ ok: true, category, categories: prefsStore.listCategories(session.username) })
  } catch (err) {
    handlePrefsError(res, err, 'create category')
  }
})

app.post('/api/prefs/categories/:id/rename', requireAuth, (req, res) => {
  const session = req.authSession as AuthSession
  try {
    prefsStore.renameCategory(session.username, Number(req.params.id), req.body?.name)
    res.json({ ok: true, categories: prefsStore.listCategories(session.username) })
  } catch (err) {
    handlePrefsError(res, err, 'rename category')
  }
})

app.delete('/api/prefs/categories/:id', requireAuth, (req, res) => {
  const session = req.authSession as AuthSession
  try {
    prefsStore.deleteCategory(session.username, Number(req.params.id))
    res.json({ ok: true, categories: prefsStore.listCategories(session.username) })
  } catch (err) {
    handlePrefsError(res, err, 'delete category')
  }
})

app.post('/api/prefs/categories/:id/channels', requireAuth, (req, res) => {
  const session = req.authSession as AuthSession
  try {
    prefsStore.addChannelToCategory(session.username, Number(req.params.id), req.body ?? {})
    res.json({ ok: true, categories: prefsStore.listCategories(session.username) })
  } catch (err) {
    handlePrefsError(res, err, 'add channel')
  }
})

app.delete('/api/prefs/categories/:id/channels/:kind/:streamId', requireAuth, (req, res) => {
  const session = req.authSession as AuthSession
  try {
    prefsStore.removeChannelFromCategory(
      session.username,
      Number(req.params.id),
      String(req.params.kind) as 'live' | 'movie' | 'series',
      Number(req.params.streamId)
    )
    res.json({ ok: true, categories: prefsStore.listCategories(session.username) })
  } catch (err) {
    handlePrefsError(res, err, 'remove channel')
  }
})

// -- EPG settings (the EPG section): which guides are configured, how healthy they are, and how
// much of the channel list they actually cover. The status read is deliberately non-blocking —
// it reports what's cached and starts missing downloads in the background, so the screen can
// poll and show sources coming online instead of hanging on a 98MB guide fetch.

/** Reads this account's stored IPTV credentials (needed by every EPG route). */
function resolveAccountCredentials(username: string): SessionCredentials | null {
  const stored = usersStore.getIptvCredentials(username)
  if (!stored) return null
  try {
    return decryptSessionCredentials(stored)
  } catch {
    return null
  }
}

app.get('/api/epg/config', requireAuth, (req, res) => {
  const session = req.authSession as AuthSession
  try {
    const credentials = resolveAccountCredentials(session.username)
    if (!credentials) {
      res.status(409).json({ error: 'No IPTV config on this account — finish the IPTV setup first' })
      return
    }
    const epgUrls = credentials.epgUrls ?? []
    const sources = epgService.peekStatus({ credentials, epgUrls })
    const summary = epgService.peekMatchSummary({ credentials })
    if (!summary) {
      // Warm the stats in the background — the client polls and picks them up.
      void epgService.getMatchSummary({ credentials, epgUrls }).catch(() => {})
    }
    res.json({ ok: true, epgUrls, sources, summary })
  } catch (err) {
    console.error('[epg] config failed:', err)
    res.status(500).json({ error: `Storage error: ${err instanceof Error ? err.message : String(err)}` })
  }
})

app.post('/api/epg/sources', requireAuth, (req, res) => {
  const session = req.authSession as AuthSession
  const raw = req.body?.epgUrls
  if (!Array.isArray(raw)) {
    res.status(400).json({ error: 'epgUrls must be an array of URLs' })
    return
  }
  // Validated, not merely pattern-matched: a guide URL is fetched *by the server*, so loopback
  // and cloud-metadata addresses are refused rather than probed.
  try {
    for (const url of raw) assertSafeExternalUrl(url)
  } catch (err) {
    if (err instanceof UnsafeUrlError) {
      res.status(400).json({ error: err.message })
      return
    }
    throw err
  }
  try {
    const credentials = resolveAccountCredentials(session.username)
    if (!credentials) {
      res.status(409).json({ error: 'No IPTV config on this account — finish the IPTV setup first' })
      return
    }
    const epgUrls = sanitizeEpgUrls(raw) ?? []
    const next: SessionCredentials = { ...credentials, epgUrls: epgUrls.length > 0 ? epgUrls : undefined }
    usersStore.setIptvCredentials(session.username, encryptSessionCredentials(next))
    // Kick off any newly-added sources so the screen shows them loading immediately.
    epgService.refresh({ credentials: next, epgUrls })
    res.json({ ok: true, epgUrls })
  } catch (err) {
    console.error('[epg] save sources failed:', err)
    res.status(500).json({ error: `Storage error: ${err instanceof Error ? err.message : String(err)}` })
  }
})

app.post('/api/epg/refresh', requireAuth, (req, res) => {
  const session = req.authSession as AuthSession
  try {
    const credentials = resolveAccountCredentials(session.username)
    if (!credentials) {
      res.status(409).json({ error: 'No IPTV config on this account — finish the IPTV setup first' })
      return
    }
    epgService.refresh({ credentials, epgUrls: credentials.epgUrls ?? [] })
    res.json({ ok: true, started: true })
  } catch (err) {
    console.error('[epg] refresh failed:', err)
    res.status(500).json({ error: `Storage error: ${err instanceof Error ? err.message : String(err)}` })
  }
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

  try {
    const session = req.authSession as AuthSession
    const normalizedServer = normalizeProxyTargetBase(server)
    sessionProxyTargets.set(session.token, normalizedServer)
    defaultProxyTargetBase = normalizedServer
    res.json({ ok: true })
  } catch (err) {
    console.error('[connect] failed:', err)
    res.status(500).json({ error: err instanceof Error ? err.message : 'Could not set the IPTV target' })
  }
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
  // The client normally sends a same-origin path (/live/user/pass/id.m3u8). An *absolute* URL in
  // that field would replace the provider base wholesale, which made this a request-forgery
  // primitive: any signed-in user could point the server at an arbitrary address and have the
  // response handed back as "video". Only the configured provider's own origin is allowed.
  let resolved: URL
  try {
    resolved = new URL(relativeOrAbsolute, targetBase)
  } catch {
    throw new Error('Invalid source URL')
  }
  if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') {
    throw new Error('Only http(s) sources are supported')
  }
  if (!isSameOrigin(resolved, new URL(targetBase))) {
    throw new Error('Refusing to fetch a URL outside the configured IPTV provider')
  }
  return resolved.href
}

app.post('/api/transcode/start', requireAuth, (req, res) => {
  const { sourceUrl, isVod, sessionId, subtitleStreamIndex, audioStreamIndex } = req.body ?? {}
  if (typeof sourceUrl !== 'string' || typeof sessionId !== 'string') {
    res.status(400).json({ error: 'Missing sourceUrl/sessionId' })
    return
  }
  let upstreamUrl: string
  try {
    upstreamUrl = resolveUpstreamUrl(sourceUrl, req)
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'No IPTV server configured' })
    return
  }
  transcodeService
    .startTranscode(upstreamUrl, Boolean(isVod), sessionId, subtitleStreamIndex, audioStreamIndex)
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
  let upstreamUrl: string
  try {
    upstreamUrl = resolveUpstreamUrl(sourceUrl, req)
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'No IPTV server configured' })
    return
  }
  transcodeService
    .probeTracks(upstreamUrl)
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
  console.log(`[setup] Database: ${path.join(DATA_DIR, 'allison.db')} (DATA_DIR=${DATA_DIR})`)
  // Diagnostics must never take the server down: an unreadable users file still lets the API
  // answer with a real, visible error instead of exiting into a restart loop.
  // Report which ffmpeg transcoding will use: a bundled static build cannot resolve
  // hostnames (see the Dockerfile), so knowing the resolved path explains transcode failures
  // instantly instead of leaving "it just hangs" to be rediscovered.
  void resolveFfmpegPath()
    .then((ffmpegPath) => console.log(`[transcode] ffmpeg: ${ffmpegPath}`))
    .catch((err) => console.error(`[transcode] no usable ffmpeg: ${err instanceof Error ? err.message : String(err)}`))

  // Segments (especially a whole movie's worth — see resolveTranscodeDir) land here, so this is
  // worth proving at boot rather than discovering as a stalled transcode later.
  const transcodeDir = resolveTranscodeDir()
  void prepareTranscodeDir(transcodeDir).then(async ({ error, swept }) => {
    if (error) {
      console.error(`[transcode] temp dir ${transcodeDir} ${error}`)
      const uid = typeof process.getuid === 'function' ? process.getuid() : null
      console.error(
        `[transcode] Set TRANSCODE_TMP_DIR to a writable path, or fix ownership for uid ${uid ?? 'unknown'} ` +
          `(a host directory created by an earlier root-run needs: sudo chown -R ${uid ?? 1000}:${uid ?? 1000} <dir>).`
      )
      return
    }
    const { freeBytes } = await transcodeService.storage()
    console.log(
      `[transcode] temp dir: ${transcodeDir}${freeBytes !== null ? ` (${formatBytes(freeBytes)} free)` : ''}` +
        (swept > 0 ? ` — cleared ${swept} leftover session dir(s)` : '')
    )
  })

  const secretProblem = checkSessionSecret()
  if (secretProblem) {
    console.error(`[setup] ${secretProblem}`)
    console.error('[setup] IPTV configuration cannot be saved until this is fixed (it is stored encrypted).')
  }
  const health = usersStore.healthCheck()
  if (!health.ok) {
    console.error(`[setup] Data directory is NOT usable: ${health.error}`)
    console.error('[setup] Check that DATA_DIR is mounted read-write (docker-compose: ./appdata:/appdata:rw) and that users.json is valid JSON.')
    // The container now runs unprivileged, so a data directory created by an earlier, root-run
    // build is owned by the wrong uid — say so, and say exactly what fixes it, rather than
    // leaving it to be inferred from an EACCES. Restarting matters as much as the chown: SQLite
    // fixes its read/write mode when it opens the file, so a permission change made while this
    // process was already running does not take effect until it reopens the database.
    const runUid = typeof process.getuid === 'function' ? process.getuid() : null
    if (runUid !== null && runUid !== 0) {
      console.error(`[setup] This process runs as uid ${runUid}; a directory created by an earlier root-run needs: sudo chown -R ${runUid}:${runUid} <your appdata dir>`)
      console.error('[setup] Fix ownership and then RESTART this container: SQLite fixes its write mode when it opens the file.')
    }
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

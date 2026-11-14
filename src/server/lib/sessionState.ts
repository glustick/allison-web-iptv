import { hashAuthToken } from './authSessionStore.js'

export const AUTH_COOKIE_NAME = 'allison_web_iptv_auth'

export function normalizeProxyTargetBase(url: string): string {
  return url.trim().replace(/\/+$/, '')
}

export function parseCookieValue(header: string | undefined, name: string): string | null {
  if (!header) return null
  const match = header
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
  if (!match) return null
  return decodeURIComponent(match.slice(name.length + 1))
}

export function getTargetForRequest(
  headers: Record<string, string | string[] | undefined>,
  defaultTarget: string | null,
  sessionTargets: Map<string, string>
): string | null {
  const headerValue = typeof headers['x-proxy-target-base'] === 'string' ? headers['x-proxy-target-base'].trim() : ''
  if (headerValue) return normalizeProxyTargetBase(headerValue)

  const cookieHeader = typeof headers.cookie === 'string' ? headers.cookie : ''
  // The auth cookie (set by the app's own username/password login) doubles as the key for
  // per-login proxy targets — one less cookie, and a logged-out browser resolves no target.
  // v0.83.0: the maps are keyed by the token's hash, so the cookie is hashed before lookup —
  // same shape the session map itself uses, and the raw token still never leaves the cookie.
  const sessionId = parseCookieValue(cookieHeader, AUTH_COOKIE_NAME)
  const sessionKey = sessionId ? hashAuthToken(sessionId) : null
  if (sessionKey && sessionTargets.has(sessionKey)) return normalizeProxyTargetBase(sessionTargets.get(sessionKey) ?? '')

  return defaultTarget ? normalizeProxyTargetBase(defaultTarget) : null
}

/**
 * The full target precedence for an authenticated proxy request (v0.105.0's scoping fix).
 * `getTargetForRequest` above answers header-vs-session; this adds the two rungs below it in
 * the order the multi-account household needs:
 *
 * 1. the explicit `x-proxy-target-base` override (a deliberate choice — always wins),
 * 2. the session's own remembered target,
 * 3. **the caller's own saved provider** — `ownStored`, resolved by the caller from the auth
 *    session — which must outrank the process default, because the default is simply
 *    *whichever account last saved or connected* (last writer wins). Before this rung existed,
 *    a fresh login's first proxy request rode that last writer's provider, and the
 *    account's-own fallback below it was unreachable in exactly the multi-account case it was
 *    written for,
 * 4. the process default — legacy single-account setups and calls with no session at all.
 *
 * Pure: the caller owns the map, the default, and the act of resolving `ownStored`.
 */
export function resolveTargetBase(
  headers: Record<string, string | string[] | undefined>,
  sessionTargets: Map<string, string>,
  defaultTarget: string | null,
  ownStored: string | null
): string | null {
  const explicit = getTargetForRequest(headers, null, sessionTargets)
  if (explicit) return normalizeProxyTargetBase(explicit)
  if (ownStored) return normalizeProxyTargetBase(ownStored)
  return defaultTarget ? normalizeProxyTargetBase(defaultTarget) : null
}

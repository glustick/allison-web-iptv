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

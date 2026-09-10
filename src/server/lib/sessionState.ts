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
  const sessionId = parseCookieValue(cookieHeader, 'allison_web_iptv_session')
  if (sessionId && sessionTargets.has(sessionId)) return normalizeProxyTargetBase(sessionTargets.get(sessionId) ?? '')

  return defaultTarget ? normalizeProxyTargetBase(defaultTarget) : null
}

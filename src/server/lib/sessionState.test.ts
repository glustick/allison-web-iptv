import { describe, expect, it } from 'vitest'
import { AUTH_COOKIE_NAME, getTargetForRequest, normalizeProxyTargetBase, parseCookieValue } from './sessionState.js'

describe('normalizeProxyTargetBase', () => {
  it('trims trailing slashes from the Xtream server URL', () => {
    expect(normalizeProxyTargetBase('https://example.com:8080///')).toBe('https://example.com:8080')
  })
})

describe('parseCookieValue', () => {
  it('reads a named cookie out of a standard Cookie header', () => {
    expect(parseCookieValue(`${AUTH_COOKIE_NAME}=abc123; theme=dark`, AUTH_COOKIE_NAME)).toBe('abc123')
  })

  it('returns null when the requested cookie is not in the header', () => {
    expect(parseCookieValue('theme=dark', AUTH_COOKIE_NAME)).toBeNull()
  })
})

describe('getTargetForRequest', () => {
  it('prefers the request-level proxy target override when present', () => {
    const targets = new Map([['session-1', 'https://session.example:8080']])

    expect(
      getTargetForRequest(
        { cookie: `${AUTH_COOKIE_NAME}=session-1`, 'x-proxy-target-base': 'https://override.example:8080/' },
        'https://default.example:8080',
        targets
      )
    ).toBe('https://override.example:8080')
  })

  it('falls back to the session target before the process default', () => {
    const targets = new Map([['session-1', 'https://session.example:8080']])

    expect(getTargetForRequest({ cookie: `${AUTH_COOKIE_NAME}=session-1` }, 'https://default.example:8080', targets)).toBe(
      'https://session.example:8080'
    )
  })

  it('uses the default when no session override exists', () => {
    expect(getTargetForRequest({}, 'https://default.example:8080', new Map())).toBe('https://default.example:8080')
  })
})

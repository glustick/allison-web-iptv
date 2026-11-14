import { describe, expect, it } from 'vitest'
import { AUTH_COOKIE_NAME, getTargetForRequest, normalizeProxyTargetBase, parseCookieValue, resolveTargetBase } from './sessionState.js'
import { hashAuthToken } from './authSessionStore.js'

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

  it('falls back to the session target before the process default (the map is hash-keyed, v0.83.0)', () => {
    // The cookie carries the raw token; the maps hash it. A raw-token key must NOT match —
    // that is the whole point of the hash-keying (raw credentials never live in map keys).
    const rawToken = 'session-1'
    const targets = new Map([[hashAuthToken(rawToken), 'https://session.example:8080']])

    expect(getTargetForRequest({ cookie: `${AUTH_COOKIE_NAME}=${rawToken}` }, 'https://default.example:8080', targets)).toBe(
      'https://session.example:8080'
    )
    expect(getTargetForRequest({ cookie: `${AUTH_COOKIE_NAME}=${rawToken}` }, 'https://default.example:8080', new Map([[rawToken, 'https://session.example:8080']]))).toBe(
      'https://default.example:8080'
    )
  })

  it('uses the default when no session override exists', () => {
    expect(getTargetForRequest({}, 'https://default.example:8080', new Map())).toBe('https://default.example:8080')
  })
})

describe('resolveTargetBase (v0.105.0 — the scoping fix)', () => {
  const tokenA = 'account-a-token'
  const mapA = new Map([[hashAuthToken(tokenA), 'https://a.example:8080']])

  it("a session without its own target gets the caller's OWN provider, not the last writer's default", () => {
    // The exact leak: account A saved last (default = A's portal); account B just logged in
    // and has no session target yet. B's request must go to B's saved provider.
    expect(
      resolveTargetBase({ cookie: `${AUTH_COOKIE_NAME}=account-b-token` }, new Map(), 'https://a.example:8080', 'https://b.example:8080')
    ).toBe('https://b.example:8080')
  })

  it('the explicit override still outranks everything', () => {
    expect(
      resolveTargetBase(
        { cookie: `${AUTH_COOKIE_NAME}=${tokenA}`, 'x-proxy-target-base': 'https://override.example/' },
        mapA,
        'https://default.example',
        'https://b.example'
      )
    ).toBe('https://override.example')
  })

  it("the session's remembered target outranks the account's own saved provider", () => {
    // A /api/connect within the session deliberately pointed elsewhere.
    expect(
      resolveTargetBase({ cookie: `${AUTH_COOKIE_NAME}=${tokenA}` }, mapA, 'https://default.example', 'https://a-saved.example')
    ).toBe('https://a.example:8080')
  })

  it('with no own provider the legacy default stands — single-account setups unchanged', () => {
    expect(resolveTargetBase({}, new Map(), 'https://default.example:8080', null)).toBe(
      'https://default.example:8080'
    )
    expect(resolveTargetBase({}, new Map(), null, null)).toBeNull()
  })
})

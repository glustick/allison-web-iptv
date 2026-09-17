import { describe, expect, it } from 'vitest'
import { assertSafeExternalUrl, isSameOrigin, isSecureRequest, securityHeaders, UnsafeUrlError } from './security.js'

function request(headers: Record<string, string> = {}, encrypted = false): Parameters<typeof isSecureRequest>[0] {
  return { headers, socket: { encrypted } } as unknown as Parameters<typeof isSecureRequest>[0]
}

describe('isSecureRequest', () => {
  it('believes a trusted proxy that says https, and a directly encrypted socket', () => {
    expect(isSecureRequest(request({ 'x-forwarded-proto': 'https' }))).toBe(true)
    expect(isSecureRequest(request({ 'x-forwarded-proto': 'https, http' }))).toBe(true)
    expect(isSecureRequest(request({}, true))).toBe(true)
    expect(isSecureRequest(request({ 'x-forwarded-proto': 'http' }))).toBe(false)
    expect(isSecureRequest(request())).toBe(false)
  })
})

describe('securityHeaders', () => {
  it('sets the baseline headers, and HSTS only over TLS', () => {
    const headers: Record<string, string> = {}
    securityHeaders(request({ 'x-forwarded-proto': 'https' }), { setHeader: (name, value) => (headers[name] = value) })

    expect(headers['X-Content-Type-Options']).toBe('nosniff')
    expect(headers['X-Frame-Options']).toBe('DENY')
    expect(headers['Strict-Transport-Security']).toContain('max-age=')
    // Execution is locked down even though media hosts are not enumerable.
    expect(headers['Content-Security-Policy']).toContain("script-src 'self'")
    expect(headers['Content-Security-Policy']).toContain("frame-ancestors 'none'")
    expect(headers['Content-Security-Policy']).toContain("object-src 'none'")

    const plain: Record<string, string> = {}
    securityHeaders(request(), { setHeader: (name, value) => (plain[name] = value) })
    expect(plain['Strict-Transport-Security']).toBeUndefined()
  })
})

describe('assertSafeExternalUrl', () => {
  it('accepts ordinary public guides', () => {
    expect(assertSafeExternalUrl('https://example.com/guide.xml').hostname).toBe('example.com')
    expect(assertSafeExternalUrl('  http://epg.example.net/x.xml  ').hostname).toBe('epg.example.net')
    // A guide on the local network is a legitimate setup and stays allowed.
    expect(assertSafeExternalUrl('http://192.168.0.10/guide.xml').hostname).toBe('192.168.0.10')
  })

  it('refuses schemes and hosts that would let it probe the machine itself', () => {
    for (const url of [
      'file:///etc/passwd',
      'ftp://example.com/x',
      'http://localhost/x',
      'http://foo.localhost/x',
      'http://127.0.0.1:8080/',
      'http://0.0.0.0/',
      'http://169.254.169.254/latest/meta-data/',
      'http://metadata.google.internal/'
    ]) {
      expect(() => assertSafeExternalUrl(url), url).toThrow(UnsafeUrlError)
    }
    expect(() => assertSafeExternalUrl('')).toThrow(UnsafeUrlError)
    expect(() => assertSafeExternalUrl(42)).toThrow(UnsafeUrlError)
    expect(() => assertSafeExternalUrl('not a url')).toThrow(UnsafeUrlError)
  })
})

describe('isSameOrigin', () => {
  it('allows the provider itself and refuses everything else', () => {
    const provider = new URL('https://provider.example:8080')
    expect(isSameOrigin(new URL('https://provider.example:8080/live/u/p/1.m3u8'), provider)).toBe(true)
    expect(isSameOrigin(new URL('https://provider.example:8080/x'), new URL('https://provider.example:8081')).valueOf()).toBe(false)
    expect(isSameOrigin(new URL('http://provider.example:8080/x'), provider)).toBe(false)
    expect(isSameOrigin(new URL('http://169.254.169.254/'), provider)).toBe(false)
    expect(isSameOrigin(new URL('https://evil.example/'), provider)).toBe(false)
  })
})

describe('hls.js needs a blob worker', () => {
  it('permits worker-src with blob: — without it every hls.js stream hangs', () => {
    const headers: Record<string, string> = {}
    securityHeaders({ headers: {} } as never, { setHeader: (n, v) => { headers[n.toLowerCase()] = v } })
    const csp = headers['content-security-policy']
    expect(csp).toContain("worker-src 'self' blob:")
    // older Safari falls back to child-src rather than worker-src
    expect(csp).toContain("child-src 'self' blob:")
  })
})

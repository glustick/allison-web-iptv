import type { IncomingMessage } from 'http'

// Small, explicit security helpers. Nothing here is clever: the point is that the app used to
// ship no security headers at all, set its session cookie without `Secure`, and resolved
// client-supplied URLs without checking where they pointed.

/** True when the request arrived over TLS — directly, or via a proxy we trust to say so. */
export function isSecureRequest(req: IncomingMessage): boolean {
  const forwarded = req.headers['x-forwarded-proto']
  const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded ?? '').split(',')[0]?.trim().toLowerCase()
  if (first === 'https') return true
  return Boolean((req.socket as { encrypted?: boolean } | undefined)?.encrypted)
}

/**
 * Baseline response headers.
 *
 * The CSP is deliberately permissive about *media and images* (provider CDNs are third parties,
 * and some providers are still plain http) but strict about everything that could execute:
 * no inline scripts, no plugins, no framing. That is what stops a compromised or malicious
 * provider from turning a channel name or programme description into script in this app.
 */
export function securityHeaders(req: IncomingMessage, res: { setHeader: (name: string, value: string) => void }): void {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader('Referrer-Policy', 'same-origin')
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()')
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self'",
      // hls.js runs its demuxer in a Web Worker created from a blob: URL. Without this directive
      // the worker falls back to default-src 'self', the browser refuses to load it, and hls.js
      // never starts — every stream it handles then hangs with no error anywhere except a console
      // line about worker-src. child-src is the same permission for Safari before 15.4.
      "worker-src 'self' blob:",
      "child-src 'self' blob:",
      // React sets style attributes, which CSP treats as inline styles.
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: https: http:",
      "media-src 'self' blob: https: http:",
      "connect-src 'self' https: http:",
      "font-src 'self' data:",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'"
    ].join('; ')
  )
  if (isSecureRequest(req)) {
    res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains')
  }
}

export class UnsafeUrlError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnsafeUrlError'
  }
}

/**
 * Validates a URL a *user* supplied (external EPG guides) before the server fetches it. Blocks the
 * schemes and hosts that turn a convenience feature into a probe of the machine's own network —
 * loopback, link-local and the common cloud metadata addresses — while still allowing a guide
 * hosted on the local network, which is a legitimate setup.
 */
export function assertSafeExternalUrl(raw: unknown): URL {
  if (typeof raw !== 'string' || raw.trim().length === 0) throw new UnsafeUrlError('A URL is required')
  let parsed: URL
  try {
    parsed = new URL(raw.trim())
  } catch {
    throw new UnsafeUrlError(`Not a valid URL: ${raw}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new UnsafeUrlError('Only http:// and https:// URLs are supported')
  }
  const host = parsed.hostname.toLowerCase()
  const blocked =
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '0.0.0.0' ||
    host === '[::1]' ||
    host === '::1' ||
    /^127\./.test(host) ||
    /^169\.254\./.test(host) || // link-local, including 169.254.169.254 (cloud metadata)
    host === 'metadata.google.internal' ||
    host === '100.100.100.200' // Alibaba Cloud metadata
  if (blocked) throw new UnsafeUrlError(`Refusing to fetch a URL pointing at this machine: ${host}`)
  return parsed
}

/** True when `candidate` stays within `base`'s origin — the guard against a client asking the
 *  server to fetch something other than the configured IPTV provider. */
export function isSameOrigin(candidate: URL, base: URL): boolean {
  return candidate.origin === base.origin
}

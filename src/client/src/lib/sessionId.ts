/**
 * A session id for the transcode endpoints.
 *
 * `crypto.randomUUID` exists **only in a secure context** — HTTPS, or `localhost`. Reached over the
 * LAN address (`http://192.168.0.20:8085`) it is `undefined`, so calling it throws a TypeError. Both
 * call sites sit in transcode start paths, and the throw happens before any promise, so it escaped
 * into React's error boundary and replaced the whole app with "Something went wrong" — the moment
 * anyone tried catch-up, or hit the E-AC-3 fallback, over plain HTTP.
 *
 * `crypto.getRandomValues` carries no such restriction, so the same version-4 UUID is built from it
 * whenever `randomUUID` is genuinely available it is used, and otherwise this never throws.
 */
export function newSessionId(): string {
  const c: Crypto | undefined = typeof crypto !== 'undefined' ? crypto : undefined
  if (c && typeof c.randomUUID === 'function') return c.randomUUID()

  const bytes = new Uint8Array(16)
  if (c && typeof c.getRandomValues === 'function') c.getRandomValues(bytes)
  else for (let i = 0; i < 16; i += 1) bytes[i] = Math.floor(Math.random() * 256)

  bytes[6] = (bytes[6] & 0x0f) | 0x40 // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80 // variant 1 (RFC 4122)
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

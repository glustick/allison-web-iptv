/**
 * "Chrome on macOS" from a user-agent string — the only thing a person can recognise in a list of
 * their own sign-ins.
 *
 * This is deliberately a small heuristic and not a parser: the question the panel answers is
 * "which of these is the laptop in front of me?", and a wrong-but-plausible label ("Safari" for an
 * iOS Chrome, which is WebKit underneath) is still more useful than a raw 120-character string.
 * Unknown input degrades to "Unknown device" rather than to a guess.
 *
 * Order matters: Edge and Opera both claim Chrome, and every Chrome claims Safari.
 */
export function describeUserAgent(userAgent: string | null | undefined): string {
  const ua = (userAgent ?? '').trim()
  if (!ua) return 'Unknown device'

  const platform =
    /iPhone/.test(ua)
      ? 'iPhone'
      : /iPad/.test(ua)
        ? 'iPad'
        : /Android/.test(ua)
          ? /Mobile/.test(ua)
            ? 'Android phone'
            : 'Android tablet'
          : /Mac OS X|Macintosh/.test(ua)
            ? 'macOS'
            : /CrOS/.test(ua)
              ? 'ChromeOS'
              : /Windows/.test(ua)
                ? 'Windows'
                : /Linux/.test(ua)
                  ? 'Linux'
                  : null

  const browser =
    /Edg\//.test(ua)
      ? 'Edge'
      : /OPR\/|Opera/.test(ua)
        ? 'Opera'
        : /Firefox\//.test(ua)
          ? 'Firefox'
          : /CriOS\/|Chrome\//.test(ua)
            ? 'Chrome'
            : /Safari\//.test(ua)
              ? 'Safari'
              : null

  if (browser && platform) return `${browser} on ${platform}`
  return browser ?? platform ?? 'Unknown device'
}

/**
 * How long ago, in the coarsest useful unit. A session list is read to spot the one you do not
 * recognise, and "3 days ago" is the fact that matters — not 74 hours.
 */
export function describeAge(thenMs: number, nowMs: number = Date.now()): string {
  const seconds = Math.max(0, Math.floor((nowMs - thenMs) / 1000))
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`
  const days = Math.floor(hours / 24)
  return `${days} day${days === 1 ? '' : 's'} ago`
}

/**
 * An address a person can read. Node reports IPv4 clients on a dual-stack socket as
 * `::ffff:127.0.0.1`, which is technically true and useless in a list meant to be recognised —
 * so the mapped prefix is the one thing worth stripping. Everything else is shown as it arrived.
 */
export function describeAddress(ip: string | null | undefined): string {
  const value = (ip ?? '').trim()
  if (!value) return 'address unknown'
  return value.startsWith('::ffff:') ? value.slice('::ffff:'.length) : value
}

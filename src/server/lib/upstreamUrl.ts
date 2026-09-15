// Mapping the client's credential-free playback paths back onto the provider's own paths.
//
// Since v0.11.0 the browser never sees the provider password: for playback it asks this app for
// GET /api/stream/<kind>/<id>.<ext>, and the /api/stream route injects the account's stored
// credentials before relaying. That is the right shape for the <video>/hls.js element, but the
// transcode entry points (POST /api/transcode/start and /api/transcode/probeTracks) take a
// client-supplied sourceUrl and hand it to ffmpeg, which fetches the source itself rather than
// going through this app's relay. Resolving that same-origin path against the *provider* base
// produces https://<provider>/api/stream/live/<id>.m3u8 — a path the provider does not have — so
// ffmpeg opened nothing and the session produced no output at all.
//
// Found live, reported as "the fallback is not working, the error fragParsingError appears": a
// Dolby (E-AC-3) live channel tripped the silent-audio fallback, the transcode session started and
// then sat there with an empty output directory, and the player was left on the un-decodable
// original stream where hls.js kept reporting fragParsingError. probeTracks told the whole story:
// the same-origin path answered {"audioTracks":[]} in 1.2s while the provider path answered with
// the channel's four real audio tracks.

/** Kinds the /api/stream route accepts (mirrors its own validation). */
export const STREAM_KINDS = ['live', 'movie', 'series', 'timeshift'] as const

const STREAM_PATH_PATTERN = /^\/api\/stream\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+\.[A-Za-z0-9]+)$/

export interface StreamPathCredentials {
  username: string
  password: string
}

/**
 * Returns the provider-relative path (/<kind>/<user>/<pass>/<file>) for a same-origin
 * /api/stream/... path, or null when the input is not one (a provider-relative path, an absolute
 * URL, or anything malformed). Callers keep their own origin checks on the result.
 */
export function mapSameOriginStreamPath(
  input: string,
  credentials: StreamPathCredentials | null | undefined
): string | null {
  // A blank credential cannot form a real provider path (this app requires a password before it
  // will store an account at all), so refuse rather than hand back a degenerate path that would
  // fail somewhere far less obvious.
  if (!credentials || !credentials.username || !credentials.password || typeof input !== 'string') return null
  // Matching the path only: the transcode entry points never need a query carry-over, and ffmpeg
  // is handed a provider URL rebuilt from scratch below rather than the client's own string.
  const pathname = input.split('#')[0].split('?')[0]
  const match = STREAM_PATH_PATTERN.exec(pathname)
  if (!match) return null
  const [, kind, file] = match
  if (!(STREAM_KINDS as readonly string[]).includes(kind)) return null
  return `/${kind}/${encodeURIComponent(credentials.username)}/${encodeURIComponent(credentials.password)}/${file}`
}

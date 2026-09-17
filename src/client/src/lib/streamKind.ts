/**
 * What kind of stream is this, really?
 *
 * Some channels are not HLS at all: the provider answers their `.m3u8` URL with a raw **MPEG-TS**
 * byte stream. hls.js expects a playlist, so it never gets one — and because LivePlayer sets
 * `ignorePlaylistParsingErrors` (deliberately, for a provider that shuffles segment sequences), even
 * the parse failure is swallowed. The player then waits for levels that never arrive: a hang with
 * nothing in the console.
 *
 * Measured on this account: Sky News FHD and HD both return ~3.8 MB of TS where a playlist should
 * be. The rule the rest of the app already follows applies — *raw MPEG-TS has to go through the
 * transcoder* — so the first bytes are worth checking before choosing a player.
 *
 * The read is aborted after the first chunk, so nothing but a few kB is transferred, and a verdict of
 * HLS is remembered for the session so a channel only pays for this once.
 */

export type StreamKind = 'hls' | 'mpegts' | 'unknown'

/** Channels answered with a real playlist this session: no need to look twice. */
const knownHls = new Set<string>()

export function forgetStreamKindCache(): void {
  knownHls.clear()
}

/** Exposed for tests; the reader only ever needs the first chunk. */
export function classifyFirstBytes(bytes: Uint8Array | undefined): StreamKind {
  if (!bytes || bytes.length === 0) return 'unknown'
  const head = new TextDecoder().decode(bytes.slice(0, 16))
  if (head.startsWith('#EXTM3U')) return 'hls'
  if (bytes[0] === 0x47) return 'mpegts' // MPEG-TS sync byte, the same 0x47 the catch-up notes record
  return 'unknown'
}

export async function sniffStreamKind(
  url: string,
  fetchImpl: typeof fetch = fetch
): Promise<StreamKind> {
  if (knownHls.has(url)) return 'hls'

  const controller = new AbortController()
  try {
    const res = await fetchImpl(url, { signal: controller.signal })
    if (!res.ok || !res.body) return 'unknown'
    const reader = res.body.getReader()
    const { value } = await reader.read()
    controller.abort() // only the first bytes were ever needed
    const kind = classifyFirstBytes(value)
    if (kind === 'hls') knownHls.add(url)
    return kind
  } catch {
    // A failed probe is not evidence of anything: let the player try normally.
    return 'unknown'
  } finally {
    controller.abort()
  }
}

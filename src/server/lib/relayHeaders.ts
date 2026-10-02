/**
 * Hop-by-hop headers stripped when relaying a request onward (RFC 7230 §6.1).
 *
 * These describe the CLIENT's connection to THIS hop and say nothing about the next one.
 * Forwarding them hands the next hop's socket lifecycle to whoever is on the public side —
 * measured 2026-10-02 with the audio session's own ffmpeg as the client: its playlist fetch
 * said `Connection: close`, which poisoned the relay's pooled socket to the internal proxy,
 * and the following segment fetch was answered by the internal proxy's parser with a bare 400
 * before any handler ran — killing the session start that the player then reported as a
 * stream with no sound and no clock. Browsers never set these headers on fetch()es, which is
 * why only ffmpeg-driven traffic ever tripped it.
 *
 * `host` goes too: the relay addresses the next hop by host:port and Node's client sets its
 * own Host accordingly.
 */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host'
])

export function stripHopByHopHeaders(
  headers: Record<string, string | string[] | undefined>
): Record<string, string | string[] | undefined> {
  const out: Record<string, string | string[] | undefined> = {}
  for (const [name, value] of Object.entries(headers)) {
    if (!HOP_BY_HOP.has(name.toLowerCase())) out[name] = value
  }
  return out
}

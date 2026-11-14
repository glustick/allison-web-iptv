// Whether this browser can decode the audio codec a stream declares. Live TV needs this
// because a Dolby (E-AC-3/AC-3) track is silently dropped by most browsers: the video plays
// perfectly and no error is raised anywhere, so nothing triggers the transcode fallback — the
// reported "channel has no audio" symptom. Deliberately a pure function (same convention as
// liveStreamRecovery.ts) so the decision is unit-testable without a browser or an hls.js
// instance; the caller injects the platform's own capability check.

export type TypeSupportProbe = (mimeType: string) => boolean

const DOLBY_CODECS = ['ec-3', 'ac-3', 'eac3', 'ac3']

/** The fMP4 codec string MSE expects for a Dolby audio codec hls.js reported. */
export function dolbyMseCodec(codec: string): string {
  const normalized = codec.toLowerCase()
  return normalized.includes('ec-3') || normalized.includes('eac3') ? 'ec-3' : 'ac-3'
}

/**
 * The codec parameter an fMP4 `audio/mp4;codecs="…"` probe needs for a codec hls.js reported,
 * or null when this module cannot name one (v0.106.0's widened gate).
 *
 * - Dolby keeps its dedicated mapping above (the original v0.6x fix).
 * - `mp4a.40.x` strings are the ISO audio object types — AAC-LC (`.2`), HE-AAC (`.5`),
 *   HE-AACv2 (`.29`, Sunderland's feed) — and probe as themselves.
 * - The other codecs that genuinely appear in HLS go by their registered names.
 *
 * The mapping is deliberately a WHITELIST rather than "pass anything through": probing a
 * made-up codec string makes the browser answer empty (no) for reasons of syntax rather than
 * capability, and a false "can't decode" costs a conversion session — a provider connection.
 * An unmapped codec keeps the old permissive behaviour (assume decodable), same as an absent
 * one: the gate only acts on codecs it can ask about honestly.
 */
const NAMED_CODECS = ['opus', 'flac', 'mp3', 'vorbis', 'alac']

export function probeableAudioCodec(codec: string): string | null {
  const normalized = codec.toLowerCase()
  if (DOLBY_CODECS.some((name) => normalized.includes(name))) return dolbyMseCodec(normalized)
  if (/^mp4a\.40\.\d+$/.test(normalized)) return normalized
  const named = NAMED_CODECS.find((name) => normalized === name)
  return named ?? null
}

/**
 * True when the codec is either absent, unmapped (cannot be asked about honestly), or a codec
 * this browser's media stack actually reports support for. Dolby was the original case —
 * silently dropped by most browsers, no error anywhere, the reported "channel has no audio"
 * symptom — and v0.106.0 widened the same question to every codec the probe CAN name.
 */
export function canDecodeAudioCodec(codec: string | undefined | null, probe: TypeSupportProbe): boolean {
  if (!codec) return true
  const probeable = probeableAudioCodec(codec)
  if (!probeable) return true
  try {
    return probe(`audio/mp4;codecs="${probeable}"`)
  } catch {
    return false
  }
}

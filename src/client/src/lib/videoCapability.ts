/**
 * Can this browser decode a stream's video? Asked *before* playback, not only after it fails.
 *
 * Every channel this provider serves is HEVC (measured 2026-09-22: the UHD tier is Main 10 at
 * 3840x2160, and even 1080p news is HEVC), while most Chromium builds have no HEVC decoder at all.
 * The app's fallback ladder is built to react to failures, and for video that is the wrong order when
 * the answer is knowable in advance: a browser that cannot decode this will never decode it, and the
 * ladder's old response was to spend the issue re-encoding 4K in real time — the most expensive thing
 * the host can be asked to do, for a viewer who only wanted to watch the channel.
 *
 * So the app asks, and *tells the viewer what it found* instead of silently converting. This is only
 * the first half of the answer: MSE's opinion is not the truth — measured in v0.45.0's own notes, some
 * Chromium builds answer `isTypeSupported(hvc1)` → true and then fail the actual append — which is
 * exactly why the ladder still exists. It just offers conversion now instead of taking it.
 *
 * Pure, with the probe injected, so every rule is testable without a browser.
 */
export type TypeSupportProbe = (mimeType: string) => boolean

/** The MSE codec string to ask about, for the codec names ffmpeg reports. */
const MSE_VIDEO_CODECS: Record<string, string> = {
  // Main 10, level 5.3, the profile the UHD tier actually carries. A browser that answers false for
  // this is being asked the question that matters; one that answers true may still fail the append,
  // which is the ladder's job, not this function's.
  hevc: 'hvc1.1.6.L153.B0',
  h265: 'hvc1.1.6.L153.B0',
  h264: 'avc1.640028',
  avc1: 'avc1.640028',
  av1: 'av01.0.08M.08',
  vp9: 'vp09.00.10.08'
}

/** A codec string that is already an RFC 6381 MSE codec (what hls.js reports for a level). */
const RFC6381 = /^(avc1|avc3|hvc1|hev1|av01|vp09|mp4v)\./i

export function mseCodecForVideo(codec: string | null | undefined): string | null {
  if (!codec) return null
  const normalized = codec.trim()
  if (RFC6381.test(normalized)) return normalized
  return MSE_VIDEO_CODECS[normalized.toLowerCase()] ?? null
}

/**
 * True when the codec is absent, unrecognised, or one the browser's media stack reports support for.
 * Deliberately optimistic on anything it cannot name: the answer here only decides whether to *warn*,
 * and a wrong "no" would block a channel that plays perfectly.
 */
export function canDecodeVideoCodec(codec: string | null | undefined, probe: TypeSupportProbe): boolean {
  const mseCodec = mseCodecForVideo(codec)
  if (!mseCodec) return true
  try {
    return probe(`video/mp4;codecs="${mseCodec}"`)
  } catch {
    return true
  }
}

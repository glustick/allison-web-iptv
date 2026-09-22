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

/**
 * Does this live stream need its container changed before *any* browser can present it?
 *
 * Measured 2026-09-22, by counting decoded video frames rather than trusting a playhead (an audio-only
 * stream advances one just as happily — the first version of that test said "plays" about a stream
 * with no video at all):
 *
 *   Sky Sports Main Event UHD, HEVC Main 10 in MPEG-TS   -> 0 frames, presentationSize 0x0, audio only
 *   the same content remuxed to fMP4 (`-c:v copy`)       -> 28 frames, 3840x2160
 *
 * The macOS native pipeline — Safari's own engine — parses an HEVC-in-TS playlist happily and then
 * presents *no video at all*: it plays the audio track and nothing else. That is not a decoding
 * question (the same Mac decodes the same bitstream from fMP4 without effort) and not a quality
 * question: it is the container, and Apple's HLS rules are explicit that HEVC belongs in fMP4.
 * hls.js has no better answer to it — a JavaScript demux of HEVC-in-TS into MSE is exactly the path
 * that never works — so this is a fact about the *stream*, not about the browser, and it applies
 * whichever engine would otherwise have been chosen.
 *
 * The fix is the cheapest one available: the transcoder's **stream copy**, which changes the container
 * and not one pixel of the video, into HLS that both engines can present natively.
 *
 * Deliberately keyed on the video codec alone. This provider's live playlists are all MPEG-TS
 * (measured), and a channel already in fMP4 would pay a pointless pass through the transcoder — but the
 * cost of being wrong that way is a little CPU, while the cost of the opposite mistake is the bug this
 * exists to fix. When a source is known to be fMP4 the caller can simply skip this; the rule stays
 * conservative rather than clever.
 */
export function needsStreamCopyRemux(state: {
  videoCodec: string | null | undefined
  isLive: boolean
}): boolean {
  if (!state.isLive) return false
  const codec = (state.videoCodec ?? '').trim().toLowerCase()
  return codec === 'hevc' || codec === 'h265'
}

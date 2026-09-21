/**
 * Should live TV be handed to the browser's own HLS pipeline instead of hls.js?
 *
 * Live TV has always been driven through hls.js wherever MediaSource exists — which includes
 * Safari, the browser this household actually watches on. That single choice is what forces
 * everything downstream of it: hls.js can only feed Media Source Extensions, so any stream MSE will
 * not take (HEVC in an MPEG-TS container, 10-bit HDR, sometimes Dolby audio) has to be transcoded
 * before the viewer sees it, every segment is demuxed and re-encapsulated in JavaScript, and the
 * picture is whatever hls.js can hand over rather than whatever the source actually contains.
 *
 * A native player like TiviMate takes the opposite route, and it is the reason it plays these
 * channels untouched: give the playlist to a decoder that understands the container, let it use the
 * hardware, and change nothing. Safari has exactly that pipeline built in, behind the same MIME type
 * HLS has used since the beginning — so the question is simply whether the browser can play HLS
 * itself, and if it can, it should.
 *
 * Chromium answers `''` (its native player has no HLS support at all), so nothing changes there and
 * hls.js stays the engine it needs. Deliberately pure, with `canPlayType` injected, so this rule is
 * testable without a browser — the same convention as liveStreamRecovery.ts.
 */
export const NATIVE_HLS_MIME = 'application/vnd.apple.mpegurl'

export function prefersNativePlayback(canPlayType: (type: string) => string): boolean {
  try {
    // Safari answers "maybe" here; Chromium and Firefox answer "". An empty string is the only
    // "no" that means anything — anything else is the browser offering its own player.
    return canPlayType(NATIVE_HLS_MIME) !== ''
  } catch {
    // A browser that throws on the question has not offered a native pipeline.
    return false
  }
}

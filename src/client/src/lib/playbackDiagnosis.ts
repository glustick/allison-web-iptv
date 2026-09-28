import { tierForVerdict, type DecodeVerdict } from './decodeGate'

/**
 * Why a channel will not play here — in one sentence, carrying the evidence that makes the next test
 * self-diagnosing rather than a repetition of the last one.
 *
 * The roadmap recorded the problem on 2026-09-22: the engine fallback (v0.46.3 made a native failure
 * re-attach with hls.js) means a *native* hiccup ends up reported as "cannot decode HEVC" on both
 * browsers. Safari and Chrome then say the same thing for different reasons, and "same error as
 * Chrome" tells the next person nothing. Two facts separate them, and both are already known at the
 * moment the message is written:
 *
 *   - whether the native pipeline had already failed (so the codec line is the *fallback* speaking,
 *     not a verdict on the codec);
 *   - what this device measured when the decode check was run (lib/decodeGate.ts) — which turns
 *     "this browser can't" into something actionable.
 *
 * Pure, so the wording rules are testable without a browser.
 */
export function describeUnplayableVideo(opts: {
  videoCodec: string | null
  engine: 'native' | 'hls' | null
  /** True when the native pipeline failed first and hls.js was attached as the fallback. */
  nativeFailed: boolean
  verdict: DecodeVerdict | null
  now?: number
}): string {
  const codec = opts.videoCodec ?? 'this video'
  const lead = opts.nativeFailed
    ? `The browser’s own HLS pipeline failed first, and the hls.js fallback cannot decode ${codec} either — ` +
      'so this is not a verdict on the codec by itself.'
    : opts.engine === 'native'
      ? `This browser’s own HLS pipeline cannot present ${codec} in this container.`
      : `This channel can’t be played in this browser — its video is ${codec}, which this browser cannot decode.`

  const now = opts.now ?? Date.now()
  const verdict = opts.verdict
  const frames = Math.round(verdict?.framesPerSecond ?? 0)
  // What this device CAN do — not a verdict on whether it is good enough. A machine with no hardware
  // decode at all is told what it managed, and a machine whose measurement is missing is asked for
  // one, rather than either being written off (the operator's correction, 2026-09-28).
  const tier = tierForVerdict(verdict, now)
  const tail =
    tier === 'comfortable'
      ? `This device decodes it directly at ${frames} fps, so a client-side player would run comfortably here — it is not built yet.`
      : tier === 'marginal'
        ? `This device decodes it directly at ${frames} fps — enough to watch, with frames dropped along the way — so a client-side player is worth having here.`
        : 'Run the decode check in Admin → System on this device to see what it can carry.'

  return `${lead} ${tail}`
}

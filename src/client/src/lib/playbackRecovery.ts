/**
 * Decides, from the browser's own decoded-byte counters, whether a title is playing fine,
 * playing with silent audio (the E-AC-3/Dolby shape), or not playing at all (the container
 * can't be demuxed — e.g. an MKV handed to Chromium, which parses only WebM-compatible
 * Matroska, i.e. VP8/VP9/AV1, never H.264).
 *
 * Extracted from NativeVideoPlayer's polling loop so the thresholds are directly testable —
 * they are the entire point of this file, and getting them wrong means either a needless
 * transcode or a viewer staring at a frozen frame.
 */

export type PlaybackVerdict = 'wait' | 'silent-audio' | 'unplayable'

export interface PlaybackWatchState {
  /** Consecutive polls that decoded video but zero audio bytes. */
  consecutiveSilentTicks: number
  /** True once any video has been decoded — distinguishes "silent" from "dead". */
  everDecodedVideo: boolean
}

export interface PlaybackSample {
  videoBytes: number
  audioBytes: number
}

export interface PlaybackLimits {
  /** Silent ticks needed before the audio codec is declared unsupported. */
  silentTicks: number
  /**
   * Polls (seconds) with nothing decoded at all before declaring the format unplayable.
   * This matters more than it looks: when the browser *cannot* demux the container it
   * decodes zero video bytes forever, so the silent-audio test never fires and the only
   * other exit used to be the hard cap below — a 90-second wait before anything happened.
   * Generous enough to survive a slow first buffer from a slow origin, short enough not to
   * feel broken.
   */
  unplayableAfterAttempts: number
  /** Absolute outer bound, whatever the byte counters say. */
  hardCapAttempts: number
}

export const DEFAULT_PLAYBACK_LIMITS: PlaybackLimits = {
  silentTicks: 2,
  unplayableAfterAttempts: 20,
  hardCapAttempts: 90
}

export function evaluatePlaybackSample(
  state: PlaybackWatchState,
  sample: PlaybackSample,
  attempts: number,
  limits: PlaybackLimits = DEFAULT_PLAYBACK_LIMITS
): { state: PlaybackWatchState; verdict: PlaybackVerdict } {
  const everDecodedVideo = state.everDecodedVideo || sample.videoBytes > 0
  const consecutiveSilentTicks =
    sample.videoBytes > 0 && sample.audioBytes === 0 ? state.consecutiveSilentTicks + 1 : 0
  const next: PlaybackWatchState = { everDecodedVideo, consecutiveSilentTicks }

  if (consecutiveSilentTicks >= limits.silentTicks) return { state: next, verdict: 'silent-audio' }
  if (!everDecodedVideo && attempts >= limits.unplayableAfterAttempts) return { state: next, verdict: 'unplayable' }
  if (attempts >= limits.hardCapAttempts) return { state: next, verdict: 'unplayable' }
  return { state: next, verdict: 'wait' }
}

import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PLAYBACK_LIMITS,
  evaluatePlaybackSample,
  type PlaybackWatchState
} from './playbackRecovery'

const fresh: PlaybackWatchState = { consecutiveSilentTicks: 0, everDecodedVideo: false }
const decoded = (videoBytes: number, audioBytes: number) => ({ videoBytes, audioBytes })

describe('evaluatePlaybackSample', () => {
  it('keeps waiting while audio and video are both decoding', () => {
    const r = evaluatePlaybackSample(fresh, decoded(50_000, 4_000), 1)
    expect(r.verdict).toBe('wait')
    expect(r.state).toEqual({ consecutiveSilentTicks: 0, everDecodedVideo: true })
  })

  it('calls it silent audio after two consecutive silent ticks', () => {
    const first = evaluatePlaybackSample(fresh, decoded(120_000, 0), 1)
    expect(first.verdict).toBe('wait')
    const second = evaluatePlaybackSample(first.state, decoded(240_000, 0), 2)
    expect(second.verdict).toBe('silent-audio')
  })

  it('resets the silent counter when audio finally decodes', () => {
    const first = evaluatePlaybackSample(fresh, decoded(120_000, 0), 1)
    const recovered = evaluatePlaybackSample(first.state, decoded(180_000, 9_000), 2)
    expect(recovered.verdict).toBe('wait')
    expect(recovered.state.consecutiveSilentTicks).toBe(0)
    expect(recovered.state.everDecodedVideo).toBe(true)
  })

  it('does NOT call it silent audio while nothing at all has decoded', () => {
    // The MKV-in-Chromium shape: zero decoded bytes on both counters, forever. This must
    // never be mistaken for "silent audio" — it is the format, not the audio codec.
    let state = fresh
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const r = evaluatePlaybackSample(state, decoded(0, 0), attempt)
      expect(r.verdict).toBe('wait')
      state = r.state
    }
    expect(state).toEqual({ consecutiveSilentTicks: 0, everDecodedVideo: false })
  })

  it('declares the format unplayable after 20 seconds of decoding nothing (not after 90)', () => {
    const at19 = evaluatePlaybackSample(fresh, decoded(0, 0), 19)
    expect(at19.verdict).toBe('wait')
    const at20 = evaluatePlaybackSample(fresh, decoded(0, 0), 20)
    expect(at20.verdict).toBe('unplayable')
  })

  it('gives video-only playback more time than the silent-audio path', () => {
    // Video decoding but audio silent already means "silent audio" after 2 ticks — so a
    // title that decodes video is never wrongly declared unplayable at the 20s mark.
    const first = evaluatePlaybackSample(fresh, decoded(1_000, 0), 1)
    expect(evaluatePlaybackSample(first.state, decoded(2_000, 0), 20).verdict).toBe('silent-audio')
  })

  it('still bails out at the hard cap whatever the counters claim', () => {
    const state: PlaybackWatchState = { consecutiveSilentTicks: 0, everDecodedVideo: true }
    const r = evaluatePlaybackSample(state, decoded(0, 0), 90)
    expect(r.verdict).toBe('unplayable')
  })

  it('exposes thresholds that stay in the intended order', () => {
    const l = DEFAULT_PLAYBACK_LIMITS
    expect(l.unplayableAfterAttempts).toBeLessThan(l.hardCapAttempts)
    expect(l.unplayableAfterAttempts).toBe(20)
  })
})

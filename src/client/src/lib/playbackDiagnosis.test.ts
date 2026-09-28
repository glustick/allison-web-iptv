import { describe, it, expect } from 'vitest'
import { describeUnplayableVideo } from './playbackDiagnosis'
import type { DecodeVerdict } from './decodeGate'

// The point of these messages is that two different failures stop looking identical: a native-engine
// hiccup reported through the fallback is not the same finding as "this browser cannot decode HEVC".

const NOW = Date.parse('2026-09-28T16:00:00Z')

const usable: DecodeVerdict = {
  measuredAt: NOW - 60_000,
  framesPerSecond: 241.6,
  presentedWidth: 3840,
  presentedHeight: 2160,
  codec: 'hev1.1.6.L153.B0'
}

describe('describeUnplayableVideo', () => {
  it('says the codec is undecodable when hls.js answered first', () => {
    const message = describeUnplayableVideo({
      videoCodec: 'hevc',
      engine: 'hls',
      nativeFailed: false,
      verdict: null,
      now: NOW
    })
    expect(message).toMatch(/cannot decode\./)
    expect(message).toMatch(/hev/)
  })

  it('says so when the native pipeline failed first, rather than blaming the codec', () => {
    const message = describeUnplayableVideo({
      videoCodec: 'hevc',
      engine: 'hls',
      nativeFailed: true,
      verdict: null,
      now: NOW
    })
    expect(message).toMatch(/own HLS pipeline failed first/)
    expect(message).toMatch(/not a verdict on the codec/)
  })

  it('names the engine when native itself cannot present the container', () => {
    const message = describeUnplayableVideo({
      videoCodec: 'hevc',
      engine: 'native',
      nativeFailed: false,
      verdict: null,
      now: NOW
    })
    expect(message).toMatch(/own HLS pipeline cannot present/)
  })

  it('turns a measured device into something actionable', () => {
    const message = describeUnplayableVideo({
      videoCodec: 'hevc',
      engine: 'hls',
      nativeFailed: false,
      verdict: usable,
      now: NOW
    })
    expect(message).toMatch(/242 fps/)
    expect(message).toMatch(/client-side player is viable/)
  })

  it('asks for the measurement when this device has none, and ignores a stale one', () => {
    const none = describeUnplayableVideo({ videoCodec: 'hevc', engine: 'hls', nativeFailed: false, verdict: null, now: NOW })
    expect(none).toMatch(/Run the decode check in Admin/)

    const stale = describeUnplayableVideo({
      videoCodec: 'hevc',
      engine: 'hls',
      nativeFailed: false,
      verdict: { ...usable, measuredAt: NOW - 30 * 24 * 3_600_000 },
      now: NOW
    })
    expect(stale).toMatch(/Run the decode check in Admin/)
  })

  it('falls back to a neutral noun when the codec is unknown', () => {
    const message = describeUnplayableVideo({ videoCodec: null, engine: 'hls', nativeFailed: false, verdict: null, now: NOW })
    expect(message).toMatch(/this video/)
  })
})

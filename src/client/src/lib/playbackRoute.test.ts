import { describe, it, expect } from 'vitest'
import { choosePlaybackRoute, type PlaybackRouteInputs } from './playbackRoute.js'
import type { DecodeVerdict } from './decodeGate.js'

const comfortableVerdict: DecodeVerdict = {
  measuredAt: Date.now(),
  framesPerSecond: 300,
  presentedWidth: 3840,
  presentedHeight: 2160,
  codec: 'hev1.2.4.L153.B0'
}

const base: PlaybackRouteInputs = {
  url: '/api/stream/live/668.m3u8',
  facts: { videoCodec: 'hevc', audioCodecs: ['eac3'] },
  plan: { needsConvert: false, needsVideo: false, playsDirect: false },
  verdict: comfortableVerdict,
  nativeHls: false,
  mseCanDecodeVideo: false,
  webCodecsAvailable: true,
  mseCanDecodeAudio: () => false
}

describe('choosePlaybackRoute — the operator\'s order: stream, then record, then device', () => {
  it('HEVC + a measured device → the client-side engine (the route the whole direction exists for)', () => {
    const route = choosePlaybackRoute(base)
    expect(route.route).toBe('webcodecs')
    expect(route.reason).toMatch(/measured/)
  })

  it('HEVC + no verdict on this device → the honest sentence, not a guess', () => {
    const route = choosePlaybackRoute({ ...base, verdict: null })
    expect(route.route).toBe('unplayable')
    expect(route.reason).toMatch(/HEVC/)
  })

  it('HEVC + a stale verdict → still unplayable up front (the ladder may still rescue)', () => {
    const stale = { ...comfortableVerdict, measuredAt: Date.now() - 40 * 24 * 3600_000 }
    const route = choosePlaybackRoute({ ...base, verdict: stale })
    expect(route.route).toBe('unplayable')
  })

  it('HEVC + Safari\'s native pipeline → the container remux, played untouched', () => {
    const route = choosePlaybackRoute({ ...base, nativeHls: true })
    expect(route.route).toBe('remux')
    expect(route.reason).toMatch(/remux/)
  })

  it('HEVC + MSE claims it (the measured lie) → one honest direct attempt, the ladder behind it', () => {
    const route = choosePlaybackRoute({ ...base, mseCanDecodeVideo: true, verdict: null })
    if (route.route !== 'direct') throw new Error(`expected direct, got ${route.route}`)
    expect(route.engine).toBe('hls')
  })

  it('H.264 video plays directly — hls.js on Chromium, native on Safari', () => {
    const hls = choosePlaybackRoute({ ...base, facts: { videoCodec: 'h264', audioCodecs: ['aac'] }, verdict: null, mseCanDecodeVideo: true })
    if (hls.route !== 'direct') throw new Error(`expected direct, got ${hls.route}`)
    expect(hls.engine).toBe('hls')
    const native = choosePlaybackRoute({ ...base, facts: { videoCodec: 'h264', audioCodecs: ['aac'] }, nativeHls: true, mseCanDecodeVideo: true })
    if (native.route !== 'direct') throw new Error(`expected direct, got ${native.route}`)
    expect(native.engine).toBe('native')
  })

  it('H.264 video with Dolby audio the browser cannot decode → the audio remux, up front', () => {
    const route = choosePlaybackRoute({ ...base, facts: { videoCodec: 'h264', audioCodecs: ['eac3'] }, verdict: null, mseCanDecodeVideo: true })
    expect(route.route).toBe('remux')
    expect(route.reason).toMatch(/eac3/)
  })

  it('Dolby audio the browser CAN decode (some builds) stays direct', () => {
    const route = choosePlaybackRoute({
      ...base,
      facts: { videoCodec: 'h264', audioCodecs: ['ac3'] },
      verdict: null,
      mseCanDecodeVideo: true,
      mseCanDecodeAudio: (codec) => /ac3/i.test(codec)
    })
    expect(route.route).toBe('direct')
  })

  it('the record table wins: a proved video-re-encode starts there without re-discovery', () => {
    const route = choosePlaybackRoute({ ...base, plan: { needsConvert: true, needsVideo: true, playsDirect: false } })
    expect(route.route).toBe('video-transcode')
  })

  it('the record table: a proved audio-remux starts at the session, skipping the silent attempt', () => {
    const route = choosePlaybackRoute({
      ...base,
      facts: { videoCodec: 'h264', audioCodecs: ['eac3'] },
      plan: { needsConvert: true, needsVideo: false, playsDirect: false },
      verdict: null
    })
    expect(route.route).toBe('remux')
    expect(route.reason).toMatch(/record/)
  })

  it('the record table: a proved direct play rides native where it exists', () => {
    const route = choosePlaybackRoute({
      ...base,
      plan: { needsConvert: false, needsVideo: false, playsDirect: true },
      verdict: null,
      mseCanDecodeVideo: true
    })
    expect(route.route).toBe('direct')
    expect(route.reason).toMatch(/record/)
  })

  it('an unprobed, unrecorded channel plays the informed default and the probe records it for next time', () => {
    const route = choosePlaybackRoute({ ...base, facts: null, verdict: null })
    expect(route.route).toBe('direct')
    expect(route.reason).toMatch(/not been probed/)
  })

  it('a non-HEVC video codec MSE declines with no native pipeline is unplayable honestly', () => {
    const route = choosePlaybackRoute({
      ...base,
      facts: { videoCodec: 'vp9', audioCodecs: ['aac'] },
      verdict: null,
      mseCanDecodeVideo: false
    })
    expect(route.route).toBe('unplayable')
    expect(route.reason).toMatch(/vp9/)
  })
})

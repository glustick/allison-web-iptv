import { describe, it, expect } from 'vitest'
import { canDecodeVideoCodec, mseCodecsForVideo, needsStreamCopyRemux } from './videoCapability.js'

describe('mseCodecsForVideo', () => {
  it('asks about both HEVC shapes this provider uses — Main and Main 10', () => {
    // Asking only about Main 10 is the wrong question for the 1080p channels, and answering it wrongly
    // pushed a playable HD channel through a server-side remux on 2026-09-23.
    expect(mseCodecsForVideo('hevc')).toEqual(['hvc1.1.6.L120.B0', 'hvc1.2.4.L153.B0'])
    expect(mseCodecsForVideo('h264')).toEqual(['avc1.640028'])
  })

  it('passes through a codec string that is already RFC 6381', () => {
    expect(mseCodecsForVideo('hvc1.2.4.L153.B0')).toEqual(['hvc1.2.4.L153.B0'])
  })

  it('has no opinion about codecs it cannot name', () => {
    expect(mseCodecsForVideo(null)).toEqual([])
    expect(mseCodecsForVideo('mpeg2video')).toEqual([])
  })
})

describe('canDecodeVideoCodec', () => {
  const asking = (answer: boolean) => {
    const asked: string[] = []
    return {
      asked,
      probe: (mimeType: string): boolean => {
        asked.push(mimeType)
        return answer
      }
    }
  }

  it('reports a browser that cannot decode HEVC — the case that started this', () => {
    const { probe, asked } = asking(false)
    expect(canDecodeVideoCodec('hevc', probe)).toBe(false)
    expect(asked).toEqual(['video/mp4;codecs="hvc1.1.6.L120.B0"', 'video/mp4;codecs="hvc1.2.4.L153.B0"'])
  })

  it('says yes when the browser takes Main even if it refuses Main 10 — the HD channel case', () => {
    // A 1080p Main feed on a machine whose MSE decodes Main but not Main 10 must be counted as
    // playable, or the app remuxes a channel that was playing fine.
    const probe = (mimeType: string): boolean => mimeType.includes('L120')
    expect(canDecodeVideoCodec('hevc', probe)).toBe(true)
  })

  it('reports a browser that can', () => {
    expect(canDecodeVideoCodec('hevc', () => true)).toBe(true)
  })

  it('says yes for a codec it cannot name, rather than blocking a channel that might play', () => {
    expect(canDecodeVideoCodec('mpeg2video', () => false)).toBe(true)
    expect(canDecodeVideoCodec(null, () => false)).toBe(true)
    expect(canDecodeVideoCodec(undefined, () => false)).toBe(true)
  })

  it('says yes when the probe itself fails — never worse than not asking', () => {
    expect(
      canDecodeVideoCodec('hevc', () => {
        throw new Error('no MediaSource here')
      })
    ).toBe(true)
  })
})

describe('needsStreamCopyRemux', () => {
  it('remuxes HEVC live video — the container the native pipeline cannot present', () => {
    // Measured: the same Mac decodes this bitstream from fMP4 (28 frames, 3840x2160) and presents
    // nothing at all from MPEG-TS (0 frames, 0x0). Container, not codec, not quality.
    expect(needsStreamCopyRemux({ videoCodec: 'hevc', isLive: true })).toBe(true)
    expect(needsStreamCopyRemux({ videoCodec: 'HEVC', isLive: true })).toBe(true)
    expect(needsStreamCopyRemux({ videoCodec: 'h265', isLive: true })).toBe(true)
  })

  it('leaves H.264 live alone — both engines play that in TS without help', () => {
    expect(needsStreamCopyRemux({ videoCodec: 'h264', isLive: true })).toBe(false)
    expect(needsStreamCopyRemux({ videoCodec: 'avc1', isLive: true })).toBe(false)
  })

  it('does not touch VOD, which is a file the transcoder already handles case by case', () => {
    expect(needsStreamCopyRemux({ videoCodec: 'hevc', isLive: false })).toBe(false)
  })

  it('says no when the codec is unknown, rather than converting on a guess', () => {
    expect(needsStreamCopyRemux({ videoCodec: null, isLive: true })).toBe(false)
    expect(needsStreamCopyRemux({ videoCodec: undefined, isLive: true })).toBe(false)
    expect(needsStreamCopyRemux({ videoCodec: '', isLive: true })).toBe(false)
  })
})

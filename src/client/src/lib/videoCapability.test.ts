import { describe, it, expect } from 'vitest'
import { canDecodeVideoCodec, mseCodecForVideo, needsStreamCopyRemux } from './videoCapability.js'

describe('mseCodecForVideo', () => {
  it('maps the codec names ffmpeg reports to the question MSE understands', () => {
    expect(mseCodecForVideo('hevc')).toBe('hvc1.1.6.L153.B0')
    expect(mseCodecForVideo('h264')).toBe('avc1.640028')
  })

  it('passes through a codec string that is already RFC 6381', () => {
    expect(mseCodecForVideo('hvc1.2.4.L153.B0')).toBe('hvc1.2.4.L153.B0')
    expect(mseCodecForVideo('avc1.4d401f')).toBe('avc1.4d401f')
  })

  it('has no opinion about codecs it cannot name', () => {
    expect(mseCodecForVideo(null)).toBeNull()
    expect(mseCodecForVideo('mpeg2video')).toBeNull()
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
    expect(asked).toEqual(['video/mp4;codecs="hvc1.1.6.L153.B0"'])
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

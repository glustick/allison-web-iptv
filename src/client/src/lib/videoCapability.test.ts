import { describe, it, expect } from 'vitest'
import { canDecodeVideoCodec, mseCodecForVideo } from './videoCapability.js'

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

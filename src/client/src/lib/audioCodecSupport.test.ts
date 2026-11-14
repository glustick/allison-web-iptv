import { describe, expect, it } from 'vitest'
import { canDecodeAudioCodec, dolbyMseCodec , probeableAudioCodec } from './audioCodecSupport'

describe('canDecodeAudioCodec', () => {
  it('treats a stream with no declared audio codec as playable', () => {
    expect(canDecodeAudioCodec(undefined, () => false)).toBe(true)
    expect(canDecodeAudioCodec('', () => false)).toBe(true)
  })

  it('allows codecs every browser decodes without consulting the probe', () => {
    let asked = false
    const probe = (): boolean => {
      asked = true
      return false
    }
    expect(canDecodeAudioCodec('aac', probe)).toBe(true)
    expect(asked).toBe(false)
  })

  it('probes the AAC family now (v0.106.0) — mp4a.40.x strings are named codecs', () => {
    const asked: string[] = []
    const probe = (mime: string): boolean => {
      asked.push(mime)
      return true
    }
    expect(canDecodeAudioCodec('mp4a.40.2', probe)).toBe(true)
    expect(asked).toEqual(['audio/mp4;codecs="mp4a.40.2"'])
  })

  it('flags Dolby audio as undecodable when the browser has no support (the reported case)', () => {
    // Chrome: E-AC-3 audio is dropped silently -> this is what triggers the transcode switch.
    expect(canDecodeAudioCodec('ec-3', () => false)).toBe(false)
    expect(canDecodeAudioCodec('ac-3', () => false)).toBe(false)
  })

  it('leaves Dolby audio alone where the browser does support it', () => {
    // Safari can decode E-AC-3 — transcoding there would be wasted work.
    expect(canDecodeAudioCodec('ec-3', () => true)).toBe(true)
  })

  it('asks the probe with the right MSE codec string and fails closed on a throwing probe', () => {
    const asked: string[] = []
    canDecodeAudioCodec('ec-3,eac3', (mime) => {
      asked.push(mime)
      return true
    })
    canDecodeAudioCodec('ac-3', (mime) => {
      asked.push(mime)
      return true
    })
    expect(asked).toEqual(['audio/mp4;codecs="ec-3"', 'audio/mp4;codecs="ac-3"'])
    expect(
      canDecodeAudioCodec('ec-3', () => {
        throw new Error('MediaSource unavailable')
      })
    ).toBe(false)
  })

  it('maps codec spellings to the MSE string', () => {
    expect(dolbyMseCodec('ec-3')).toBe('ec-3')
    expect(dolbyMseCodec('eac3')).toBe('ec-3')
    expect(dolbyMseCodec('ac-3')).toBe('ac-3')
  })

  // v0.106.0 — the widened gate. Sunderland's HE-AACv2 feed was the named blind spot: not
  // Dolby, so the old gate never asked, and a browser that cannot decode it had no path to the
  // conversion tier.
  it('asks about HE-AACv2 (mp4a.40.29) and converts when the browser says no', () => {
    const asked: string[] = []
    expect(canDecodeAudioCodec('mp4a.40.29', (mime) => {
      asked.push(mime)
      return false
    })).toBe(false)
    expect(asked).toEqual(['audio/mp4;codecs="mp4a.40.29"'])
  })

  it('asks about the other named codecs by their registered names', () => {
    for (const codec of ['opus', 'flac', 'mp3', 'vorbis', 'alac']) {
      expect(canDecodeAudioCodec(codec, () => false)).toBe(false)
    }
  })

  it('an unmapped codec string stays permissive — no honest question, no conversion', () => {
    // A made-up or exotic string must not become a false "can't decode": that spends a
    // provider connection on a guess.
    expect(canDecodeAudioCodec('some-future-codec', () => false)).toBe(true)
    expect(canDecodeAudioCodec('', () => false)).toBe(true)
  })

  it('probeableAudioCodec maps Dolby spellings and rejects garbage', () => {
    expect(probeableAudioCodec('eac3')).toBe('ec-3')
    expect(probeableAudioCodec('MP4A.40.5')).toBe('mp4a.40.5')
    // A combined string carrying a Dolby part maps to it (the old gate probed these too).
    expect(probeableAudioCodec('mp4a.40.2,ec-3')).toBe('ec-3')
    expect(probeableAudioCodec('future-codec')).toBeNull()
  })
})

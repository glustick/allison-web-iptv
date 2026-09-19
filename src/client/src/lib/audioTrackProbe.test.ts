import { afterEach, describe, expect, it, vi } from 'vitest'
import { forgetProbedTracks, probeAudioTracks } from './audioTrackProbe'

afterEach(() => { forgetProbedTracks() })

function jsonResponse(body: unknown, ok = true) {
  return { ok, status: ok ? 200 : 500, json: async () => body } as unknown as Response
}

describe('probeAudioTracks', () => {
  it('reports the tracks in index order', async () => {
    const f = vi.fn(async () => jsonResponse({
      audioTracks: [{ index: 2, codec: 'aac' }, { index: 0, codec: 'eac3' }, { index: 1, codec: 'eac3' }]
    })) as unknown as typeof fetch
    expect(await probeAudioTracks('/api/stream/live/42801.m3u8', f)).toEqual([
      { index: 0, codec: 'eac3' },
      { index: 1, codec: 'eac3' },
      { index: 2, codec: 'aac' }
    ])
  })

  it('sends the stream URL the server should probe', async () => {
    const f = vi.fn(async () => jsonResponse({ audioTracks: [] })) as unknown as typeof fetch
    await probeAudioTracks('/api/stream/live/42801.m3u8', f)
    const [, init] = (f as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]
    expect(JSON.parse(String(init.body))).toEqual({ sourceUrl: '/api/stream/live/42801.m3u8' })
  })

  it('returns nothing usable when the probe fails, rather than guessing', async () => {
    const network = vi.fn(async () => { throw new Error('offline') }) as unknown as typeof fetch
    expect(await probeAudioTracks('/x.m3u8', network)).toEqual([])
    const error = vi.fn(async () => jsonResponse({}, false)) as unknown as typeof fetch
    expect(await probeAudioTracks('/x.m3u8', error)).toEqual([])
  })

  it('copes with a response that has no audio tracks at all', async () => {
    const f = vi.fn(async () => jsonResponse({ subtitleTracks: [] })) as unknown as typeof fetch
    expect(await probeAudioTracks('/x.m3u8', f)).toEqual([])
  })
})

describe('the probe cache', () => {
  it('asks once per channel per session', async () => {
    const f = vi.fn(async () => jsonResponse({ audioTracks: [{ index: 0, codec: 'eac3' }] })) as unknown as typeof fetch
    await probeAudioTracks('/api/stream/live/42801.m3u8', f)
    await probeAudioTracks('/api/stream/live/42801.m3u8', f)
    expect(f).toHaveBeenCalledTimes(1)
  })

  it('still probes a different channel', async () => {
    const f = vi.fn(async () => jsonResponse({ audioTracks: [{ index: 0, codec: 'aac' }] })) as unknown as typeof fetch
    await probeAudioTracks('/api/stream/live/1.m3u8', f)
    await probeAudioTracks('/api/stream/live/2.m3u8', f)
    expect(f).toHaveBeenCalledTimes(2)
  })
})

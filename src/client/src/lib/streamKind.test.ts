import { afterEach, describe, expect, it, vi } from 'vitest'
import { classifyFirstBytes, forgetStreamKindCache, sniffStreamKind } from './streamKind'

const ts = new Uint8Array([0x47, 0x00, 0x11, 0x20, 0x00])
const hls = new TextEncoder().encode('#EXTM3U\n#EXT-X-VERSION:3\n')
const junk = new TextEncoder().encode('<html>not a stream</html>')

afterEach(() => { forgetStreamKindCache() })

describe('classifyFirstBytes', () => {
  it('recognises a playlist', () => {
    expect(classifyFirstBytes(hls)).toBe('hls')
  })

  it('recognises raw MPEG-TS by its sync byte — the Sky News case', () => {
    expect(classifyFirstBytes(ts)).toBe('mpegts')
  })

  it('says nothing useful about anything else', () => {
    expect(classifyFirstBytes(junk)).toBe('unknown')
    expect(classifyFirstBytes(new Uint8Array([]))).toBe('unknown')
    expect(classifyFirstBytes(undefined)).toBe('unknown')
  })
})

function responseWith(bytes: Uint8Array) {
  let sent = false
  return {
    ok: true,
    status: 200,
    body: {
      getReader: () => ({
        read: async () => {
          if (sent) return { done: true, value: undefined }
          sent = true
          return { done: false, value: bytes }
        }
      })
    }
  } as unknown as Response
}

describe('sniffStreamKind', () => {
  it('reports a playlist', async () => {
    const f = vi.fn(async () => responseWith(hls)) as unknown as typeof fetch
    expect(await sniffStreamKind('/api/stream/live/1.m3u8', f)).toBe('hls')
  })

  it('reports raw TS so the caller can route it to the transcoder', async () => {
    const f = vi.fn(async () => responseWith(ts)) as unknown as typeof fetch
    expect(await sniffStreamKind('/api/stream/live/37421.m3u8', f)).toBe('mpegts')
  })

  it('does not look twice at a channel that answered with a playlist', async () => {
    const f = vi.fn(async () => responseWith(hls)) as unknown as typeof fetch
    await sniffStreamKind('/api/stream/live/1.m3u8', f)
    await sniffStreamKind('/api/stream/live/1.m3u8', f)
    expect(f).toHaveBeenCalledTimes(1)
  })

  it('treats a failed probe as "unknown" rather than as evidence', async () => {
    const f = vi.fn(async () => { throw new Error('offline') }) as unknown as typeof fetch
    expect(await sniffStreamKind('/api/stream/live/1.m3u8', f)).toBe('unknown')
  })

  it('treats an error response as "unknown" too', async () => {
    const f = vi.fn(async () => ({ ok: false, status: 504 }) as unknown as Response) as unknown as typeof fetch
    expect(await sniffStreamKind('/api/stream/live/1.m3u8', f)).toBe('unknown')
  })
})

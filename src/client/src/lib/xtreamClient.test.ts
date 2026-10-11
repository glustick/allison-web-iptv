import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { XtreamClient } from './xtreamClient.js'

// These exist because the provider password used to be embedded in every URL the client made —
// API calls and stream paths alike — so it appeared in browser history, in devtools, and in any
// access log in front of the app. The client is now credential-free and the server addresses the
// provider; these tests are the guard that keeps it that way.

const origin = 'http://localhost:8085'

beforeEach(() => {
  vi.stubGlobal('window', { location: { origin } })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('stream URLs', () => {
  it('builds a same-origin app path with no credentials in it', () => {
    const client = new XtreamClient()
    expect(client.getStreamUrl('live', 37421, 'm3u8')).toBe('/api/stream/live/37421.m3u8')
    expect(client.getStreamUrl('movie', 52422, 'mp4')).toBe('/api/stream/movie/52422.mp4')
    expect(client.getStreamUrl('series', 1155, 'mkv')).toBe('/api/stream/series/1155.mkv')
  })

  it('never puts a user or password segment in a stream path', () => {
    const url = new XtreamClient().getStreamUrl('movie', 52422, 'mp4')
    expect(url).not.toMatch(/\/movie\/[^/]+\/[^/]+\//)
    expect(url.split('/').filter(Boolean)).toEqual(['api', 'stream', 'movie', '52422.mp4'])
  })

  it('builds catch-up URLs that stay same-origin and credential-free', () => {
    expect(new XtreamClient().getTimeshiftUrl(668, 1789533000, 30)).toBe('/api/timeshift/668.ts?start=1789533000&duration=30')
  })

  it('scopes catch-up URLs to the playlist like every other builder (v0.78.0)', () => {
    const scoped = new XtreamClient('p2').getTimeshiftUrl(668, 1789533000, 30)
    expect(scoped).toBe('/api/iptv/playlists/p2/timeshift/668.ts?start=1789533000&duration=30')
    // And the scoped stream path, so the whole playback path stays on one playlist's relay.
    expect(new XtreamClient('p2').getStreamUrl('live', 668, 'm3u8')).toBe('/api/iptv/playlists/p2/stream/live/668.m3u8')
  })
})

describe('API calls', () => {
  it('goes through the server front door, without credentials in the query', async () => {
    const fetchMock = vi.fn(async (_url: string) => ({ ok: true, json: async () => ({ user_info: { auth: 1 } }) }))
    vi.stubGlobal('fetch', fetchMock)

    await new XtreamClient().authenticate()

    const called = String(fetchMock.mock.calls[0]?.[0])
    expect(called.startsWith(`${origin}/api/xtream`)).toBe(true)
    expect(called).not.toContain('password')
    expect(called).not.toContain('username')
  })

  it('passes the action through as a query parameter', async () => {
    const fetchMock = vi.fn(async (_url: string) => ({ ok: true, json: async () => [] }))
    vi.stubGlobal('fetch', fetchMock)

    await new XtreamClient().getVodStreams('12')

    const called = new URL(String(fetchMock.mock.calls[0]?.[0]))
    expect(called.pathname).toBe('/api/xtream')
    expect(called.searchParams.get('action')).toBe('get_vod_streams')
    expect(called.searchParams.get('category_id')).toBe('12')
    expect(called.searchParams.has('password')).toBe(false)
  })
})

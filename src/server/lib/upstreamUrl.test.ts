import { describe, expect, it } from 'vitest'
import { mapSameOriginStreamPath, parseSameOriginTimeshiftPath } from './upstreamUrl.js'

const creds = { username: 'glustick', password: 'secret' }

describe('mapSameOriginStreamPath', () => {
  it('maps the credential-free playback paths the client now sends onto provider paths', () => {
    // The regression this exists for: without the mapping these resolved against the provider
    // base and 404'd, so ffmpeg produced no output and the fallback could never work.
    expect(mapSameOriginStreamPath('/api/stream/live/37421.m3u8', creds)).toBe('/live/glustick/secret/37421.m3u8')
    expect(mapSameOriginStreamPath('/api/stream/movie/52422.mp4', creds)).toBe('/movie/glustick/secret/52422.mp4')
    expect(mapSameOriginStreamPath('/api/stream/series/1234.mkv', creds)).toBe('/series/glustick/secret/1234.mkv')
    expect(mapSameOriginStreamPath('/api/stream/timeshift/99.ts', creds)).toBe('/timeshift/glustick/secret/99.ts')
  })

  it('percent-encodes credentials so unusual characters cannot reshape the path', () => {
    const mapped = mapSameOriginStreamPath('/api/stream/live/1.m3u8', { username: 'user name', password: 'p@ss/word+1' })
    expect(mapped).toBe('/live/user%20name/p%40ss%2Fword%2B1/1.m3u8')
  })

  it('ignores a query or fragment when matching', () => {
    expect(mapSameOriginStreamPath('/api/stream/live/1.m3u8?token=x#frag', creds)).toBe('/live/glustick/secret/1.m3u8')
  })

  it('leaves anything that is not one of those paths alone', () => {
    const untouched = [
      '/live/glustick/secret/1.m3u8', // already a provider path
      'https://primehub.primeprox.store/live/glustick/secret/1.m3u8',
      '/api/xtream?action=get_live_streams',
      '/api/stream/bogus/1.ts', // kind the /api/stream route would itself reject
      '/api/stream/live/nested/1.ts',
      '/api/stream/live/1', // no extension
      '/api/stream/live/../../etc/passwd',
      '/player_api.php',
      '',
      '/'
    ]
    for (const input of untouched) expect(mapSameOriginStreamPath(input, creds), input).toBeNull()
  })

  it('returns null without credentials rather than inventing a path', () => {
    expect(mapSameOriginStreamPath('/api/stream/live/1.m3u8', null)).toBeNull()
    expect(mapSameOriginStreamPath('/api/stream/live/1.m3u8', undefined)).toBeNull()
    expect(mapSameOriginStreamPath('/api/stream/live/1.m3u8', { username: '', password: '' })).toBeNull()
    expect(mapSameOriginStreamPath('/api/stream/live/1.m3u8', { username: 'user', password: '' })).toBeNull()
  })
})

describe('parseSameOriginTimeshiftPath', () => {
  it('reads a catch-up URL the browser would ask the transcoder to convert', () => {
    const parsed = parseSameOriginTimeshiftPath('/api/timeshift/37237.ts?start=1789533000&duration=30')
    expect(parsed).toEqual({ file: '37237.ts', startSeconds: 1789533000, durationMinutes: 30 })
  })

  it('tolerates a fragment or reordered query', () => {
    expect(parseSameOriginTimeshiftPath('/api/timeshift/1.ts?duration=5&start=1700000000#x')).toEqual({
      file: '1.ts',
      startSeconds: 1700000000,
      durationMinutes: 5
    })
  })

  it('refuses anything that is not one, so the transcoder can still fetch normal sources', () => {
    for (const input of [
      '/api/stream/live/1.m3u8',
      '/api/timeshift/1.ts',                       // no start/duration
      '/api/timeshift/1.ts?start=abc&duration=5',
      '/api/timeshift/nested/1.ts?start=1&duration=2',
      '/timeshift/glustick/x/1.ts',
      '',
      'https://example.com/api/timeshift/1.ts?start=1&duration=2'
    ]) {
      expect(parseSameOriginTimeshiftPath(input), input).toBeNull()
    }
  })
})

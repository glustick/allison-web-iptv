import { describe, expect, it } from 'vitest'
import { parsePlaylistWindow, probeVerdict, windowAdvanced } from './offAirProbe.js'

const WINDOW = { startSN: 100, endSN: 114 }

describe('parsePlaylistWindow', () => {
  it('reads the sequence and counts the segments', () => {
    const playlist = ['#EXTM3U', '#EXT-X-MEDIA-SEQUENCE:100', '#EXTINF:4,', 's1.ts', 's2.ts', 's3.ts'].join('\n')
    expect(parsePlaylistWindow(playlist)).toEqual({ startSN: 100, endSN: 102 })
  })

  it('answers null for anything that is not a media playlist with segments', () => {
    expect(parsePlaylistWindow('#EXTM3U\n#EXT-X-STREAM-INF:...\nmaster.m3u8')).toBeNull()
    expect(parsePlaylistWindow('<html>error page</html>')).toBeNull()
    expect(parsePlaylistWindow('#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:7\n')).toBeNull()
  })
})

describe('windowAdvanced', () => {
  it('a moved window — end or start — means broadcasting again', () => {
    expect(windowAdvanced(WINDOW, { startSN: 100, endSN: 115 })).toBe(true)
    expect(windowAdvanced(WINDOW, { startSN: 101, endSN: 115 })).toBe(true)
  })

  it('an identical window is the same frozen placeholder', () => {
    expect(windowAdvanced(WINDOW, WINDOW)).toBe(false)
    expect(windowAdvanced(WINDOW, { startSN: 99, endSN: 114 })).toBe(false)
  })
})

describe('probeVerdict', () => {
  it('resumes the moment the window moves', () => {
    expect(probeVerdict(WINDOW, { startSN: 100, endSN: 115 }, 0)).toBe('resume')
  })

  it('an unparseable or failed fetch keeps probing — one bad answer is not evidence', () => {
    expect(probeVerdict(WINDOW, null, 5)).toBe('keep-probing')
  })

  it('gives up at the bound', () => {
    expect(probeVerdict(WINDOW, null, 120)).toBe('give-up')
    expect(probeVerdict(WINDOW, WINDOW, 119)).toBe('keep-probing')
  })
})

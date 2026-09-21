import { describe, expect, it } from 'vitest'
import {
  hasHint,
  pruneHints,
  rememberHint,
  TRANSCODE_HINT_LIMIT,
  TRANSCODE_HINT_TTL_MS
} from './transcodeHints'

const now = 1_789_560_000_000

describe('pruneHints', () => {
  it('keeps fresh, well-formed entries and drops everything else', () => {
    const raw = [
      { url: '/api/stream/live/37421.m3u8', at: now - 1000 },
      { url: '', at: now },
      { url: '/old', at: now - TRANSCODE_HINT_TTL_MS - 1 },
      { url: '/future', at: now + 60_000 },
      { notAHint: true },
      null,
      'nonsense'
    ]
    expect(pruneHints(raw, now).map((h) => h.url)).toEqual(['/api/stream/live/37421.m3u8'])
  })

  it('survives rubbish in storage rather than throwing', () => {
    expect(pruneHints('not an array', now)).toEqual([])
    expect(pruneHints(undefined, now)).toEqual([])
  })

  it('orders newest first and honours the cap', () => {
    const many = Array.from({ length: TRANSCODE_HINT_LIMIT + 20 }, (_, i) => ({ url: `/s${i}`, at: now - i }))
    const pruned = pruneHints(many, now)
    expect(pruned).toHaveLength(TRANSCODE_HINT_LIMIT)
    expect(pruned[0].url).toBe('/s0')
  })
})

describe('rememberHint', () => {
  it('adds a hint and refreshes one that is already there', () => {
    const once = rememberHint([], '/live/1', now)
    expect(hasHint(once, '/live/1')).toBe(true)
    const twice = rememberHint(once, '/live/1', now + 5000)
    expect(twice).toHaveLength(1)
    expect(twice[0].at).toBe(now + 5000)
  })

  it('ignores an empty url rather than storing a useless entry', () => {
    expect(rememberHint([], '', now)).toEqual([])
  })

  it('stays bounded', () => {
    let hints = rememberHint([], '/x', now)
    for (let i = 0; i < TRANSCODE_HINT_LIMIT + 10; i += 1) hints = rememberHint(hints, `/s${i}`, now + i)
    expect(hints.length).toBeLessThanOrEqual(TRANSCODE_HINT_LIMIT)
  })
})

describe('video re-encode hints', () => {
  it('records and reports the video tier', () => {
    expect(rememberHint([], '/live/1', now, true)[0].video).toBe(true)
  })

  it('leaves an existing video flag alone when only the audio remux is noted again', () => {
    const withVideo = rememberHint([], '/live/1', now, true)
    const refreshed = rememberHint(withVideo, '/live/1', now + 1000, undefined)
    expect(refreshed[0].video).toBe(true)
    expect(refreshed[0].at).toBe(now + 1000)
  })

  it('clears the video flag only when explicitly asked', () => {
    const withVideo = rememberHint([], '/live/1', now, true)
    expect(rememberHint(withVideo, '/live/1', now + 1, false)[0].video).toBeUndefined()
  })

  it('keeps the video flag through pruning, and drops it when it is not exactly true', () => {
    const pruned = pruneHints(
      [
        { url: '/a', at: now, video: true },
        { url: '/b', at: now, video: 'yes' },
        { url: '/c', at: now }
      ],
      now
    )
    expect(pruned.find((h) => h.url === '/a')?.video).toBe(true)
    expect(pruned.find((h) => h.url === '/b')?.video).toBeUndefined()
    expect(pruned.find((h) => h.url === '/c')?.video).toBeUndefined()
  })
})


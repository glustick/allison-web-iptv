import { describe, it, expect } from 'vitest'
import {
  INITIAL_LIVE_LOOP_STATE,
  LIVE_LOOP_LATENCY_SEC,
  parseLivePlaylist,
  planLiveLoop,
  segmentUrlBySequence,
  type LiveLoopState,
  type LivePlaylist
} from './liveSegmentLoop.js'

function playlistText(options: {
  mediaSequence?: number
  targetDuration?: number
  count: number
  durationSec?: number
  ended?: boolean
  urlAt?: (sequence: number) => string
}): string {
  const mediaSequence = options.mediaSequence ?? 100
  const duration = options.durationSec ?? 4
  const urlAt = options.urlAt ?? ((sequence: number) => `/seg-${sequence}.ts`)
  const lines = ['#EXTM3U', `#EXT-X-VERSION:3`, `#EXT-X-TARGETDURATION:${options.targetDuration ?? 4}`]
  if (options.ended) lines.push('#EXT-X-ENDLIST')
  lines.push(`#EXT-X-MEDIA-SEQUENCE:${mediaSequence}`)
  for (let i = 0; i < options.count; i++) {
    const sequence = mediaSequence + i
    lines.push(`#EXTINF:${duration},`)
    lines.push(urlAt(sequence))
  }
  return lines.join('\n')
}

describe('parseLivePlaylist', () => {
  it('reads the media sequence, target duration, and every segment with its duration', () => {
    const parsed = parseLivePlaylist(playlistText({ mediaSequence: 4100, count: 3, durationSec: 4.0 }))
    expect(parsed).not.toBeNull()
    expect(parsed!.mediaSequence).toBe(4100)
    expect(parsed!.targetDurationSec).toBe(4)
    expect(parsed!.segments).toEqual([
      { url: '/seg-4100.ts', durationSec: 4 },
      { url: '/seg-4101.ts', durationSec: 4 },
      { url: '/seg-4102.ts', durationSec: 4 }
    ])
    expect(parsed!.ended).toBe(false)
  })

  it('marks ENDLIST, survives a missing media sequence, and rejects text that is not a playlist', () => {
    const ended = parseLivePlaylist(playlistText({ count: 2, ended: true }))
    expect(ended!.ended).toBe(true)
    const noSequence = parseLivePlaylist('#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4.0,\n/seg-a.ts\n#EXTINF:4.0,\n/seg-b.ts')
    expect(noSequence!.mediaSequence).toBe(0)
    expect(noSequence!.segments).toHaveLength(2)
    expect(parseLivePlaylist('<html><body>504</body></html>')).toBeNull()
    expect(parseLivePlaylist('/seg-a.ts\n/seg-b.ts')).toBeNull()
    expect(parseLivePlaylist('')).toBeNull()
  })
})

describe('planLiveLoop', () => {
  it('joins behind the live edge at the latency target, not at the oldest segment', () => {
    // 12 segments of 4s = 48s of window; 9s of latency ≈ 2 segments back from the edge.
    const { state, plan } = planLiveLoop(INITIAL_LIVE_LOOP_STATE, parseLivePlaylist(playlistText({ mediaSequence: 100, count: 12 }))!)
    expect(plan.fetches.map((fetch) => fetch.sequence)).toEqual([110, 111])
    expect(plan.rejoined).toBe(false)
    expect(state.nextSequence).toBe(112)
    // Caught up after the join's fetches — the next poll waits at playlist cadence.
    expect(plan.nextPollMs).toBe(4000)
  })

  it('fetches only what is new, by absolute sequence, across a sliding window', () => {
    const first = planLiveLoop(INITIAL_LIVE_LOOP_STATE, parseLivePlaylist(playlistText({ mediaSequence: 100, count: 6 }))!)
    // The window slides: two old segments fell out, two new ones appeared.
    const second = planLiveLoop(first.state, parseLivePlaylist(playlistText({ mediaSequence: 102, count: 6 }))!)
    expect(second.plan.fetches.map((fetch) => fetch.sequence)).toEqual([106, 107])
    expect(second.plan.rejoined).toBe(false)
  })

  it('rejoins at the latency target when it fell out of the window entirely, and says so', () => {
    const first = planLiveLoop(INITIAL_LIVE_LOOP_STATE, parseLivePlaylist(playlistText({ mediaSequence: 100, count: 6 }))!)
    const stale = planLiveLoop(first.state, parseLivePlaylist(playlistText({ mediaSequence: 900, count: 6 }))!)
    expect(stale.plan.rejoined).toBe(true)
    // 900..905, edge 906, join 2 back → 904, 905.
    expect(stale.plan.fetches.map((fetch) => fetch.sequence)).toEqual([904, 905])
  })

  it('bounds a long catch-up over several polls instead of one burst', () => {
    const first = planLiveLoop(INITIAL_LIVE_LOOP_STATE, parseLivePlaylist(playlistText({ mediaSequence: 100, count: 6 }))!)
    // A window 40 segments long while the loop sits at 106: 12 now, the rest on later polls.
    const behind = planLiveLoop(first.state, parseLivePlaylist(playlistText({ mediaSequence: 100, count: 40 }))!)
    expect(behind.plan.fetches).toHaveLength(12)
    expect(behind.plan.nextPollMs).toBe(500)
    expect(behind.state.nextSequence).toBe(118)
  })

  it('keeps the fresh URL for a sequence when the window slides past re-signing', () => {
    const first = planLiveLoop(INITIAL_LIVE_LOOP_STATE, parseLivePlaylist(playlistText({ mediaSequence: 100, count: 6 }))!)
    // The window advanced AND every URL was re-signed — new segments are fetched by their fresh URLs.
    const reSigned = planLiveLoop(
      first.state,
      parseLivePlaylist(playlistText({ mediaSequence: 102, count: 6, urlAt: (sequence) => `/fresh-${sequence}.ts` }))!
    )
    expect(reSigned.plan.fetches.map((fetch) => fetch.url)).toEqual(['/fresh-106.ts', '/fresh-107.ts'])
  })

  it('reports a stagnant playlist only after enough caught-up polls with an unmoved window', () => {
    const text = playlistText({ mediaSequence: 100, count: 6 })
    const snapshot = parseLivePlaylist(text)!
    let state = INITIAL_LIVE_LOOP_STATE
    let stagnant: boolean | null = null
    for (let poll = 0; poll < 6; poll++) {
      const planned = planLiveLoop(state, snapshot)
      state = planned.state
      stagnant = planned.plan.stagnant
    }
    expect(stagnant).toBe(true)

    // The same number of polls, but the window advances every second one — never stagnant.
    let advancing: LiveLoopState = INITIAL_LIVE_LOOP_STATE
    let everStagnant = false
    for (let poll = 0; poll < 6; poll++) {
      const snapshotN = parseLivePlaylist(playlistText({ mediaSequence: 100 + Math.floor(poll / 2) * 2, count: 6 }))!
      const planned = planLiveLoop(advancing, snapshotN)
      advancing = planned.state
      everStagnant ||= planned.plan.stagnant
    }
    expect(everStagnant).toBe(false)
  })

  it('polled while catching up does not accumulate stagnation against a slow window', () => {
    const first = planLiveLoop(INITIAL_LIVE_LOOP_STATE, parseLivePlaylist(playlistText({ mediaSequence: 100, count: 6 }))!)
    // Same window (stale), but the loop still has segments to fetch — not stagnant, and not counting.
    const second = planLiveLoop(first.state, parseLivePlaylist(playlistText({ mediaSequence: 102, count: 6 }))!)
    expect(second.state.stagnantPolls).toBe(0)
    expect(second.plan.stagnant).toBe(false)
  })
})

describe('segmentUrlBySequence', () => {
  it('answers by absolute sequence from a fresh snapshot, and null outside it', () => {
    const snapshot = parseLivePlaylist(playlistText({ mediaSequence: 200, count: 3 }))!
    expect(segmentUrlBySequence(snapshot, 200)).toBe('/seg-200.ts')
    expect(segmentUrlBySequence(snapshot, 202)).toBe('/seg-202.ts')
    expect(segmentUrlBySequence(snapshot, 199)).toBeNull()
    expect(segmentUrlBySequence(snapshot, 203)).toBeNull()
  })
})

describe('latency constant', () => {
  it('sits behind the edge far enough to absorb decode jitter, ahead of signature expiry territory', () => {
    expect(LIVE_LOOP_LATENCY_SEC).toBeGreaterThanOrEqual(6)
    expect(LIVE_LOOP_LATENCY_SEC).toBeLessThanOrEqual(15)
  })
})

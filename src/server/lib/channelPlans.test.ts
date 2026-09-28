import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  FACTS_TTL_MS,
  PLAN_TTL_MS,
  createChannelPlansStore,
  describePlan,
  factsAreFresh,
  planIsTrustworthy,
  type ChannelPlan
} from './channelPlans.js'
import { openDatabase } from './db.js'

// The store holds two different kinds of thing and must not confuse them: **facts** (what the stream
// carries, learned by probing — kept even before anyone has played it, because fetching them is the
// round trip this exists to remove) and a **plan** (what this channel needed, only ever written from a
// playback that worked). These pin that distinction, the failure path, and the upgrade from the
// narrower table v0.61.0 shipped.

const dirs: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'channel-plans-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const NOW = Date.parse('2026-09-28T16:00:00Z')

describe('the store', () => {
  it('remembers what a channel needed, and reads it back', () => {
    const store = createChannelPlansStore({ dataDir: tempDir() })
    store.record('chris', '/api/stream/live/668.m3u8', { video: false, audio: true, note: 'E-AC-3 first' })
    const plans = store.list('chris')
    expect(plans).toHaveLength(1)
    expect(plans[0]).toMatchObject({ key: '/api/stream/live/668.m3u8', video: false, audio: true, failures: 0, proved: true })
  })

  it('survives a restart — the whole reason it is in the database rather than localStorage', () => {
    const dir = tempDir()
    createChannelPlansStore({ dataDir: dir }).record('chris', 'live:668', { video: true, audio: true })
    const afterRestart = createChannelPlansStore({ dataDir: dir }).list('chris')
    expect(afterRestart).toHaveLength(1)
    expect(afterRestart[0].video).toBe(true)
  })

  it('keeps probed codecs even when nobody has played the channel yet', () => {
    const store = createChannelPlansStore({ dataDir: tempDir() })
    store.rememberFacts('chris', 'live:668', { videoCodec: 'hevc', audioCodecs: ['eac3', 'aac'] })
    const plan = store.list('chris')[0]
    expect(plan.videoCodec).toBe('hevc')
    expect(plan.audioCodecs).toEqual(['eac3', 'aac'])
    // …and a probe is NOT a proof: acting on it as one would let a guess masquerade as a plan.
    expect(plan.proved).toBe(false)
    expect(planIsTrustworthy(plan, NOW)).toBe(false)
    expect(factsAreFresh(plan)).toBe(true)
  })

  it('keeps one account’s channels out of another’s', () => {
    const store = createChannelPlansStore({ dataDir: tempDir() })
    store.record('chris', 'live:1', { video: true, audio: false })
    expect(store.list('someone-else')).toHaveLength(0)
  })

  it('refreshes a plan on a later success instead of duplicating it', () => {
    const store = createChannelPlansStore({ dataDir: tempDir() })
    store.record('chris', 'live:1', { video: true, audio: true })
    store.record('chris', 'live:1', { video: false, audio: true })
    const plans = store.list('chris')
    expect(plans).toHaveLength(1)
    expect(plans[0].video).toBe(false)
  })

  it('carries probed codecs along with a proved plan', () => {
    const store = createChannelPlansStore({ dataDir: tempDir() })
    store.record('chris', 'live:1', {
      video: true,
      audio: true,
      facts: { videoCodec: 'hevc', audioCodecs: ['eac3'] }
    })
    const plan = store.list('chris')[0]
    expect(plan).toMatchObject({ proved: true, videoCodec: 'hevc', audioCodecs: ['eac3'] })
    expect(plan.factsAt).toBeGreaterThan(0)
  })

  it('forgets a failed plan but keeps the facts — the failure says nothing about the codecs', () => {
    const store = createChannelPlansStore({ dataDir: tempDir() })
    store.record('chris', 'live:1', { video: true, audio: true, facts: { videoCodec: 'hevc', audioCodecs: ['eac3'] } })
    store.markFailed('chris', 'live:1', 'player reported a media error')
    const plan = store.list('chris')[0]
    expect(plan.proved).toBe(false)
    expect(plan.video).toBe(false)
    expect(plan.audio).toBe(false)
    expect(plan.failures).toBe(1)
    expect(plan.videoCodec).toBe('hevc')
    expect(planIsTrustworthy(plan, NOW)).toBe(false)
  })

  it('drops a row that has nothing left on it after a failure', () => {
    const store = createChannelPlansStore({ dataDir: tempDir() })
    store.record('chris', 'live:1', { video: true, audio: true })
    store.markFailed('chris', 'live:1', 'no facts were ever probed')
    expect(store.list('chris')).toHaveLength(0)
  })

  it('upgrades the table v0.61.0 shipped, rather than failing on it', () => {
    const dir = tempDir()
    // The old shape: no proved / video_codec / audio_codecs / facts_at columns, and no defaults.
    const handle = openDatabase(dir)
    handle.db.exec(`
      CREATE TABLE channel_plans (
        owner TEXT NOT NULL,
        channel_key TEXT NOT NULL,
        video INTEGER NOT NULL DEFAULT 0,
        audio INTEGER NOT NULL DEFAULT 0,
        verified_at INTEGER NOT NULL,
        failures INTEGER NOT NULL DEFAULT 0,
        note TEXT,
        PRIMARY KEY (owner, channel_key)
      )
    `)
    handle.db
      .prepare('INSERT INTO channel_plans (owner, channel_key, video, audio, verified_at) VALUES (?, ?, 1, 1, ?)')
      .run('chris', 'live:legacy', NOW)
    handle.close()

    const store = createChannelPlansStore({ dataDir: dir })
    const plan = store.list('chris')[0]
    expect(plan.key).toBe('live:legacy')
    expect(plan.video).toBe(true)
    // A legacy row was written by the old `record`, which only ever ran after a successful playback —
    // but the column did not exist, so it reads as unproved and is re-learned once. Honest either way.
    expect(plan.proved).toBe(false)
    store.rememberFacts('chris', 'live:legacy', { videoCodec: 'h264', audioCodecs: ['aac'] })
    expect(store.list('chris')[0].videoCodec).toBe('h264')
  })
})

describe('planIsTrustworthy / factsAreFresh', () => {
  const base: ChannelPlan = {
    key: 'live:1',
    video: false,
    audio: true,
    verifiedAt: NOW - 60_000,
    proved: true,
    failures: 0,
    note: null,
    videoCodec: 'hevc',
    audioCodecs: ['eac3'],
    factsAt: NOW - 60_000
  }

  it('trusts a fresh, proved, unbroken plan', () => {
    expect(planIsTrustworthy(base, NOW)).toBe(true)
  })

  it('distrusts one that has failed since, however fresh', () => {
    expect(planIsTrustworthy({ ...base, failures: 1 }, NOW)).toBe(false)
  })

  it('distrusts a stale plan — upstream re-encodes happen', () => {
    expect(planIsTrustworthy({ ...base, verifiedAt: NOW - PLAN_TTL_MS - 1 }, NOW)).toBe(false)
  })

  it('distrusts an unproved row, and nothing at all', () => {
    expect(planIsTrustworthy({ ...base, proved: false }, NOW)).toBe(false)
    expect(planIsTrustworthy(null, NOW)).toBe(false)
  })

  it('trusts facts for their own, shorter window', () => {
    expect(factsAreFresh(base, NOW)).toBe(true)
    expect(factsAreFresh({ ...base, factsAt: NOW - FACTS_TTL_MS - 1 }, NOW)).toBe(false)
    // Facts are shorter-lived than a plan: a provider swapping a feed is a fact changing, not a proof.
    expect(FACTS_TTL_MS).toBeLessThan(PLAN_TTL_MS)
  })

  it('does not pretend an empty probe is a fact', () => {
    expect(factsAreFresh({ ...base, videoCodec: null, audioCodecs: [] }, NOW)).toBe(false)
  })
})

describe('describePlan', () => {
  it('says what was proved and when', () => {
    const plan: ChannelPlan = {
      key: 'live:1',
      video: false,
      audio: true,
      verifiedAt: NOW - 7_200_000,
      proved: true,
      failures: 0,
      note: null,
      videoCodec: null,
      audioCodecs: [],
      factsAt: 0
    }
    expect(describePlan(plan, NOW)).toBe('video copy, audio re-encode — proved 2 h ago')
  })

  it('says so when the channel is unknown', () => {
    expect(describePlan(null, NOW)).toMatch(/has not been proved yet/)
  })

  it('says a broken plan will be re-discovered rather than presenting it as current', () => {
    const plan: ChannelPlan = {
      key: 'live:1',
      video: true,
      audio: true,
      verifiedAt: NOW - 60_000,
      proved: true,
      failures: 2,
      note: null,
      videoCodec: null,
      audioCodecs: [],
      factsAt: 0
    }
    expect(describePlan(plan, NOW)).toMatch(/it failed since/)
  })
})

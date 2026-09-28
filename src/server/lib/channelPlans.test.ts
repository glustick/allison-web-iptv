import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { PLAN_TTL_MS, createChannelPlansStore, describePlan, planIsTrustworthy } from './channelPlans.js'

// The point of this store is that a channel is discovered ONCE — and that a wrong answer never
// outlives being wrong. Both halves are pinned here: the record survives a restart (that is the
// feature), and a failure removes it (that is what keeps the feature honest).

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
    expect(plans[0]).toMatchObject({ key: '/api/stream/live/668.m3u8', video: false, audio: true, failures: 0 })
  })

  it('survives a restart — the whole reason it is in the database rather than localStorage', () => {
    const dir = tempDir()
    createChannelPlansStore({ dataDir: dir }).record('chris', 'live:668', { video: true, audio: true })
    const afterRestart = createChannelPlansStore({ dataDir: dir }).list('chris')
    expect(afterRestart).toHaveLength(1)
    expect(afterRestart[0].video).toBe(true)
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

  it('forgets a failed plan, so the next play discovers it again', () => {
    const store = createChannelPlansStore({ dataDir: tempDir() })
    store.record('chris', 'live:1', { video: true, audio: true })
    store.markFailed('chris', 'live:1', 'player reported a media error')
    // Not "flagged stale" — gone. Keeping the learned flags after a failure is the trap: the next
    // play would repeat an answer that has just been proved wrong.
    expect(store.list('chris')).toHaveLength(0)
  })
})

describe('planIsTrustworthy', () => {
  const base = { key: 'live:1', video: false, audio: true, verifiedAt: NOW - 60_000, failures: 0, note: null }

  it('trusts a fresh, unbroken plan', () => {
    expect(planIsTrustworthy(base, NOW)).toBe(true)
  })

  it('distrusts one that has failed since, however fresh', () => {
    expect(planIsTrustworthy({ ...base, failures: 1 }, NOW)).toBe(false)
  })

  it('distrusts a stale plan — upstream re-encodes happen', () => {
    expect(planIsTrustworthy({ ...base, verifiedAt: NOW - PLAN_TTL_MS - 1 }, NOW)).toBe(false)
  })

  it('distrusts nothing at all', () => {
    expect(planIsTrustworthy(null, NOW)).toBe(false)
  })
})

describe('describePlan', () => {
  it('says what was proved and when', () => {
    expect(describePlan({ key: 'live:1', video: false, audio: true, verifiedAt: NOW - 7_200_000, failures: 0, note: null }, NOW)).toBe(
      'video copy, audio re-encode — proved 2 h ago'
    )
  })

  it('says so when the channel is unknown', () => {
    expect(describePlan(null, NOW)).toMatch(/has not been proved yet/)
  })

  it('says a broken plan will be re-discovered rather than presenting it as current', () => {
    expect(
      describePlan({ key: 'live:1', video: true, audio: true, verifiedAt: NOW - 60_000, failures: 2, note: null }, NOW)
    ).toMatch(/it failed since/)
  })
})

import { describe, expect, it } from 'vitest'
import { DEFAULT_VOD_BUDGET_BYTES, planVodEvictions, resolveVodBudgetBytes, vodStartRefusal } from './vodBudget.js'

const GB = 1024 ** 3

describe('resolveVodBudgetBytes', () => {
  it('defaults to 16 GiB when unset or blank', () => {
    expect(resolveVodBudgetBytes(undefined)).toBe(DEFAULT_VOD_BUDGET_BYTES)
    expect(resolveVodBudgetBytes('   ')).toBe(DEFAULT_VOD_BUDGET_BYTES)
    expect(DEFAULT_VOD_BUDGET_BYTES).toBe(16 * GB)
  })

  it('reads plain bytes and suffixed sizes, case-insensitively', () => {
    expect(resolveVodBudgetBytes('1073741824')).toBe(GB)
    expect(resolveVodBudgetBytes('8GiB')).toBe(8 * GB)
    expect(resolveVodBudgetBytes('8gib')).toBe(8 * GB)
    expect(resolveVodBudgetBytes('10gb')).toBe(10 * 1000 ** 3)
    expect(resolveVodBudgetBytes('512MiB')).toBe(512 * 1024 ** 2)
    expect(resolveVodBudgetBytes('1.5 GiB')).toBe(Math.round(1.5 * GB))
  })

  it('zero disables the bound — the operator can ask for the old behaviour back', () => {
    expect(resolveVodBudgetBytes('0')).toBe(0)
  })

  it('garbage reads as the default rather than as disabled', () => {
    // A typo must not silently turn the bound off; it falls back to the safe default.
    expect(resolveVodBudgetBytes('lots')).toBe(DEFAULT_VOD_BUDGET_BYTES)
    expect(resolveVodBudgetBytes('-5GB')).toBe(DEFAULT_VOD_BUDGET_BYTES)
  })
})

describe('vodStartRefusal', () => {
  it('refuses only at or past the bound, with both numbers in the sentence', () => {
    expect(vodStartRefusal(10 * GB, 16 * GB)).toBeNull()
    const refusal = vodStartRefusal(16 * GB, 16 * GB)
    expect(refusal).toContain('16.0 GB')
    expect(refusal).toContain('TRANSCODE_VOD_MAX_TOTAL_BYTES')
  })

  it('a disabled bound never refuses', () => {
    expect(vodStartRefusal(999 * GB, 0)).toBeNull()
  })
})

describe('planVodEvictions', () => {
  const sessions = [
    { sessionId: 'live', isVod: false, idleMs: 999_999, bytes: 5 * GB, ageMs: 999_999 },
    { sessionId: 'watched', isVod: true, idleMs: 1_000, bytes: 9 * GB, ageMs: 999_999 },
    { sessionId: 'abandoned', isVod: true, idleMs: 600_000, bytes: 8 * GB, ageMs: 999_999 },
    { sessionId: 'paused', isVod: true, idleMs: 120_000, bytes: 6 * GB, ageMs: 999_999 }
  ]

  it('evicts the most idle VOD sessions first, until the total fits', () => {
    // 24 GB held vs a 16 GB bound: abandoned (8) goes, then paused (6) — 10 GB remains.
    expect(planVodEvictions(sessions, 24 * GB, 16 * GB)).toEqual(['abandoned', 'paused'])
  })

  it('one eviction is enough when one session covers the excess', () => {
    expect(planVodEvictions(sessions, 18 * GB, 16 * GB)).toEqual(['abandoned'])
  })

  it('never touches live sessions, however idle and however large the overshoot', () => {
    const evicted = planVodEvictions(sessions, 90 * GB, 16 * GB)
    expect(evicted).not.toContain('live')
    expect(evicted).toEqual(['abandoned', 'paused', 'watched'])
  })

  it('answers empty when within the bound or the bound is disabled', () => {
    expect(planVodEvictions(sessions, 15 * GB, 16 * GB)).toEqual([])
    expect(planVodEvictions(sessions, 90 * GB, 0)).toEqual([])
  })

  it('breaks ties on bytes — the bigger session frees the disk faster', () => {
    const tied = [
      { sessionId: 'small', isVod: true, idleMs: 1000, bytes: 2 * GB, ageMs: 999_999 },
      { sessionId: 'big', isVod: true, idleMs: 1000, bytes: 9 * GB, ageMs: 999_999 }
    ]
    expect(planVodEvictions(tied, 10 * GB, 5 * GB)).toEqual(['big'])
  })

  it('never evicts a session inside the grace window — a film seconds old holds almost nothing', () => {
    const young = [
      { sessionId: 'fresh', isVod: true, idleMs: 0, bytes: 20 * GB, ageMs: 5_000 },
      { sessionId: 'old', isVod: true, idleMs: 60_000, bytes: 1 * GB, ageMs: 999_999 }
    ]
    // Only 'old' is evictable; evicting it is not enough, and the answer says so honestly
    // rather than reaching for the young session.
    expect(planVodEvictions(young, 21 * GB, 5 * GB)).toEqual(['old'])
    // With no grace at all, the young giant is evictable like any other — by idle order.
    expect(planVodEvictions(young, 21 * GB, 5 * GB, 0)).toEqual(['old', 'fresh'])
  })
})

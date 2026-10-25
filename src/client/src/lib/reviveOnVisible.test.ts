import { describe, expect, it } from 'vitest'
import { MAX_AUTO_REVIVES, shouldAutoRevive, shouldKickRecovery } from './reviveOnVisible.js'

// The always-on tab's bounded self-healing (v0.84.0) — the decision logic only; the actions
// live in LivePlayer and are the Retry button's own code path.

describe('shouldAutoRevive', () => {
  it('revives a terminal state while attempts remain', () => {
    expect(shouldAutoRevive({ terminal: true, autoReviveAttempts: 0 })).toBe(true)
    expect(shouldAutoRevive({ terminal: true, autoReviveAttempts: MAX_AUTO_REVIVES - 1 })).toBe(true)
  })

  it('never revives a non-terminal state, and stops at the cap', () => {
    expect(shouldAutoRevive({ terminal: false, autoReviveAttempts: 0 })).toBe(false)
    expect(shouldAutoRevive({ terminal: true, autoReviveAttempts: MAX_AUTO_REVIVES })).toBe(false)
    expect(shouldAutoRevive({ terminal: true, autoReviveAttempts: MAX_AUTO_REVIVES + 5 })).toBe(false)
  })
})

describe('shouldKickRecovery', () => {
  it('kicks a stalled stream with a live instance, exactly once per visible event (caller resets nothing)', () => {
    expect(shouldKickRecovery({ terminal: false, hasInstance: true, stalled: true })).toBe(true)
  })

  it('no kick for terminal states (the revive path owns those), destroyed instances, or healthy streams', () => {
    expect(shouldKickRecovery({ terminal: true, hasInstance: true, stalled: true })).toBe(false)
    expect(shouldKickRecovery({ terminal: false, hasInstance: false, stalled: true })).toBe(false)
    expect(shouldKickRecovery({ terminal: false, hasInstance: true, stalled: false })).toBe(false)
  })
})

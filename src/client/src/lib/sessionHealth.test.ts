import { describe, expect, it } from 'vitest'
import { isDeadSessionTerminal, MAX_SESSION_REPLACEMENTS, shouldRestartDeadSession } from './sessionHealth'

const dead = { alive: false, hasSession: true, awaiting: false, replacements: 0 }

describe('shouldRestartDeadSession', () => {
  it('restarts a dead session the player is actually running off', () => {
    expect(shouldRestartDeadSession(dead)).toBe(true)
    expect(shouldRestartDeadSession({ ...dead, replacements: MAX_SESSION_REPLACEMENTS - 1 })).toBe(true)
  })

  it('never fires while the session is alive, or without a session, or mid-restart', () => {
    expect(shouldRestartDeadSession({ ...dead, alive: true })).toBe(false)
    expect(shouldRestartDeadSession({ ...dead, hasSession: false })).toBe(false)
    expect(shouldRestartDeadSession({ ...dead, awaiting: true })).toBe(false)
  })

  it('stops at the budget — the terminal sentence takes over', () => {
    expect(shouldRestartDeadSession({ ...dead, replacements: MAX_SESSION_REPLACEMENTS })).toBe(false)
  })
})

describe('isDeadSessionTerminal', () => {
  it('is terminal only with the budget spent on a dead, held session', () => {
    expect(isDeadSessionTerminal({ ...dead, replacements: MAX_SESSION_REPLACEMENTS })).toBe(true)
    expect(isDeadSessionTerminal({ ...dead, replacements: MAX_SESSION_REPLACEMENTS - 1 })).toBe(false)
    expect(isDeadSessionTerminal({ ...dead, replacements: MAX_SESSION_REPLACEMENTS, alive: true })).toBe(false)
    expect(isDeadSessionTerminal({ ...dead, replacements: MAX_SESSION_REPLACEMENTS, hasSession: false })).toBe(false)
    // A replacement already in flight owns the run — never sentence over it.
    expect(isDeadSessionTerminal({ ...dead, replacements: MAX_SESSION_REPLACEMENTS, awaiting: true })).toBe(false)
  })
})

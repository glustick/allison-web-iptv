import { describe, expect, it } from 'vitest'
import { describeAuthOutcome } from './authActivity'

describe('auth outcome labels', () => {
  it('names the everyday events in plain language', () => {
    expect(describeAuthOutcome('ok')).toEqual({ label: 'Signed in', tone: 'ok' })
    expect(describeAuthOutcome('failed').tone).toBe('bad')
    expect(describeAuthOutcome('logout').label).toBe('Signed out')
  })

  it('tells the one-login rule apart from an admin action', () => {
    // "Ended by a newer sign-in" is the app working as designed; "Ended by an admin" is not.
    expect(describeAuthOutcome('revoked').label).toBe('Ended by a newer sign-in')
    expect(describeAuthOutcome('force-logout').tone).toBe('warn')
  })

  it('does not invent a friendly name for an unknown outcome', () => {
    expect(describeAuthOutcome('something-new')).toEqual({ label: 'something-new', tone: 'neutral' })
  })
})

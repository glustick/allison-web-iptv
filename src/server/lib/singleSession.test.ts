import { describe, it, expect } from 'vitest'
import { revocableSessionTokens } from './singleSession.js'

describe('revocableSessionTokens', () => {
  const sessions = new Map([
    ['old-tab', { username: 'chris' }],
    ['older-tab', { username: 'chris' }],
    ['fresh', { username: 'chris' }],
    ['someone-else', { username: 'sam' }]
  ])

  it('retires every other login of the same account, keeping only the fresh one', () => {
    expect(revocableSessionTokens(sessions, 'chris', 'fresh').sort()).toEqual(['old-tab', 'older-tab'])
  })

  it('never touches another account\'s sessions', () => {
    const revoked = revocableSessionTokens(sessions, 'sam', 'someone-else')
    expect(revoked).toEqual([])
    // And an account with no other logins revokes nothing.
    expect(revocableSessionTokens(sessions, 'nobody', 'absent')).toEqual([])
  })

  it('answers nothing for an empty registry', () => {
    expect(revocableSessionTokens(new Map(), 'chris', 'fresh')).toEqual([])
  })
})

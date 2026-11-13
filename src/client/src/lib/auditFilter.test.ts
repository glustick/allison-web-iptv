import { describe, expect, it } from 'vitest'
import { auditFilterQuery } from './auditFilter.js'

describe('auditFilterQuery', () => {
  it('answers the bare limit when neither side is filtered', () => {
    expect(auditFilterQuery('', '')).toBe('limit=50')
  })

  it('trims the username before filtering on it', () => {
    expect(auditFilterQuery('  chris ', '')).toBe('username=chris&limit=50')
  })

  it('URL-encodes usernames that carry characters with query meaning', () => {
    expect(auditFilterQuery('a b', '')).toBe('username=a+b&limit=50')
  })

  it('passes a known outcome through', () => {
    expect(auditFilterQuery('', 'failed')).toBe('outcome=failed&limit=50')
  })

  it('drops an unknown outcome rather than asking for it', () => {
    expect(auditFilterQuery('', 'nonsense')).toBe('limit=50')
  })

  it('composes both sides when both are set', () => {
    expect(auditFilterQuery('chris', 'ok')).toBe('username=chris&outcome=ok&limit=50')
  })

  it('honours an explicit limit', () => {
    expect(auditFilterQuery('', '', 200)).toBe('limit=200')
  })
})

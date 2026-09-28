import { describe, it, expect } from 'vitest'
import { parseCollapsedGroups, serializeCollapsedGroups, toggleCollapsedGroup } from './sportsGroups'

describe('parseCollapsedGroups', () => {
  it('reads back what was written', () => {
    expect([...parseCollapsedGroups(serializeCollapsedGroups(new Set(['provider-nba', 'api-NFL'])))]).toEqual([
      'provider-nba',
      'api-NFL'
    ])
  })

  it('treats nothing stored as nothing collapsed', () => {
    expect(parseCollapsedGroups(null).size).toBe(0)
    expect(parseCollapsedGroups('').size).toBe(0)
  })

  it('never throws on a corrupt or hand-edited value', () => {
    expect(parseCollapsedGroups('{not json').size).toBe(0)
    expect(parseCollapsedGroups('"a string"').size).toBe(0)
    expect(parseCollapsedGroups('{"a":1}').size).toBe(0)
    // Non-string entries are dropped rather than handed to a Set membership test.
    expect([...parseCollapsedGroups('["ok", 7, null, ""]')]).toEqual(['ok'])
  })
})

describe('toggleCollapsedGroup', () => {
  it('collapses then expands the same group, leaving the others untouched', () => {
    const start = new Set(['provider-nba'])
    const collapsed = toggleCollapsedGroup(start, 'provider-nfl')
    expect([...collapsed].sort()).toEqual(['provider-nba', 'provider-nfl'])
    expect([...toggleCollapsedGroup(collapsed, 'provider-nfl')]).toEqual(['provider-nba'])
  })

  it('does not mutate the set it is given', () => {
    const start = new Set(['a'])
    toggleCollapsedGroup(start, 'b')
    expect([...start]).toEqual(['a'])
  })
})

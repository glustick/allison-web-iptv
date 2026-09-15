import { describe, expect, it } from 'vitest'
import { sectionTitle } from './sectionTitle'

describe('sectionTitle', () => {
  it('names the category whose channels are on screen (the bug this exists for)', () => {
    // A provider category used to read "All channels" even though only its channels were listed.
    expect(sectionTitle({ type: 'provider', id: '12' }, { provider: 'Sky Sports' })).toBe('Sky Sports')
  })

  it('names a user category', () => {
    expect(sectionTitle({ type: 'custom', id: 3 }, { custom: 'Kids' })).toBe('Kids')
  })

  it('keeps the library headings', () => {
    expect(sectionTitle({ type: 'favourites' })).toBe('Favourites')
    expect(sectionTitle({ type: 'history' })).toBe('Watch history')
  })

  it('says "All channels" only when it means all channels', () => {
    expect(sectionTitle({ type: 'all' })).toBe('All channels')
  })

  it('falls back to "All channels" while the category list is still loading', () => {
    expect(sectionTitle({ type: 'provider', id: '12' })).toBe('All channels')
    expect(sectionTitle({ type: 'custom', id: 3 })).toBe('All channels')
  })
})

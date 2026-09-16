import { describe, expect, it } from 'vitest'
import { parseLibraryView } from './libraryView'

describe('parseLibraryView', () => {
  it('accepts the two real views', () => {
    expect(parseLibraryView('guide', 'list')).toBe('guide')
    expect(parseLibraryView('list', 'guide')).toBe('list')
  })

  it('falls back per caller, so Favourites defaults to the guide and a category to its list', () => {
    // The reported gap: Favourites showed no guide at all, while the list is where reordering and
    // removing happen — hence two different defaults rather than one global one.
    expect(parseLibraryView(null, 'guide')).toBe('guide')
    expect(parseLibraryView(null, 'list')).toBe('list')
    expect(parseLibraryView('nonsense', 'guide')).toBe('guide')
    expect(parseLibraryView(undefined, 'list')).toBe('list')
    expect(parseLibraryView(42, 'list')).toBe('list')
  })
})

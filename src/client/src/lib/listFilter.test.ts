import { describe, expect, it } from 'vitest'
import { filterByText, matchesText, normalizeForSearch } from './listFilter'

describe('filtering a list by text', () => {
  it('ignores case and accents', () => {
    expect(matchesText('Cuenta atrás', 'cuenta')).toBe(true)
    expect(matchesText('Cuenta atrás', 'atras')).toBe(true)
    expect(matchesText('Matchday Build-up', 'MATCHDAY')).toBe(true)
  })

  it('matches anywhere in the name, not just the start', () => {
    expect(matchesText('Sky Sports Main Event', 'sports')).toBe(true)
    expect(matchesText('Sky Sports Main Event', 'news')).toBe(false)
  })

  it('treats an empty query as "everything"', () => {
    expect(matchesText('anything', '   ')).toBe(true)
    expect(filterByText([1, 2, 3], '', String)).toEqual([1, 2, 3])
  })

  it('filters without reordering what survives', () => {
    const items = [{ name: 'Zulu' }, { name: 'alpha' }, { name: 'Zebra' }]
    expect(filterByText(items, 'z', (item) => item.name).map((item) => item.name)).toEqual(['Zulu', 'Zebra'])
  })

  it('normalizes to a comparable form', () => {
    expect(normalizeForSearch('  Cuenta   atrás ')).toBe('cuenta   atras')
  })
})

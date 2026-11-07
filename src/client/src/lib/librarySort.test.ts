import { describe, expect, it } from 'vitest'
import { readLibrarySort, sortFilms, writeLibrarySort } from './librarySort'

const films = [
  { name: 'Zulu', added: '1700000000' },
  { name: 'alpha', added: '2026-11-01 10:00:00' },
  { name: 'Bravo', added: '' },
  { name: 'Charlie', added: '2026-10-01 10:00:00' }
]

function fakeStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial))
  return { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v) }
}

describe('library sorting', () => {
  it('leaves the provider order alone by default', () => {
    expect(sortFilms(films, 'default').map((f) => f.name)).toEqual(['Zulu', 'alpha', 'Bravo', 'Charlie'])
  })

  it('sorts by name case-insensitively', () => {
    expect(sortFilms(films, 'name').map((f) => f.name)).toEqual(['alpha', 'Bravo', 'Charlie', 'Zulu'])
  })

  it('sorts newest first across both timestamp shapes, with an undated film last', () => {
    // 1700000000 is 2023-11-14; the two ISO dates are newer/older than each other.
    expect(sortFilms(films, 'added').map((f) => f.name)).toEqual(['alpha', 'Charlie', 'Zulu', 'Bravo'])
  })

  it('does not mutate the array it was given', () => {
    const original = films.slice()
    sortFilms(films, 'name')
    expect(films).toEqual(original)
  })

  it('round-trips the preference and ignores rubbish', () => {
    const storage = fakeStorage()
    expect(readLibrarySort(storage)).toBe('default')
    writeLibrarySort('name', storage)
    expect(readLibrarySort(storage)).toBe('name')
    expect(readLibrarySort(fakeStorage({ 'iptv:library-sort': 'sideways' }))).toBe('default')
    expect(readLibrarySort(null)).toBe('default')
  })
})

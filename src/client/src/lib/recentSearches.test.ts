import { describe, expect, it } from 'vitest'
import { clearRecentSearches, readRecentSearches, rememberSearch } from './recentSearches'

function fakeStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial))
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k)
  }
}

describe('recent searches', () => {
  it('keeps the newest first', () => {
    const storage = fakeStorage()
    rememberSearch('sky sports', storage)
    rememberSearch('news', storage)
    expect(readRecentSearches(storage)).toEqual(['news', 'sky sports'])
  })

  it('dedupes case-insensitively, and the newer spelling wins', () => {
    const storage = fakeStorage()
    rememberSearch('Sky Sports', storage)
    rememberSearch('news', storage)
    expect(rememberSearch('sky sports', storage)).toEqual(['sky sports', 'news'])
  })

  it('caps the list at five', () => {
    const storage = fakeStorage()
    for (const term of ['one', 'two', 'three', 'four', 'five', 'six']) rememberSearch(term, storage)
    expect(readRecentSearches(storage)).toEqual(['six', 'five', 'four', 'three', 'two'])
  })

  it('ignores a keystroke that is not a search', () => {
    const storage = fakeStorage()
    rememberSearch('s', storage)
    rememberSearch('   ', storage)
    expect(readRecentSearches(storage)).toEqual([])
  })

  it('collapses whitespace so one search is one entry', () => {
    const storage = fakeStorage()
    expect(rememberSearch('  sky   sports ', storage)).toEqual(['sky sports'])
  })

  it('survives a broken store and clears on request', () => {
    // Both halves broken — a full store (a throwing write) is the case that used to *claim* the
    // query had been remembered while the next read would find nothing.
    const broken = {
      getItem: () => { throw new Error('nope') },
      setItem: () => { throw new Error('full') },
      removeItem: () => {}
    }
    expect(readRecentSearches(broken)).toEqual([])
    expect(rememberSearch('news', broken)).toEqual([])
    const storage = fakeStorage()
    rememberSearch('news', storage)
    expect(clearRecentSearches(storage)).toEqual([])
    expect(readRecentSearches(storage)).toEqual([])
  })

  it('ignores rubbish stored under the key', () => {
    expect(readRecentSearches(fakeStorage({ 'iptv:recent-searches': '{"a":1}' }))).toEqual([])
    expect(readRecentSearches(fakeStorage({ 'iptv:recent-searches': '["ok", 5, ""]' }))).toEqual(['ok'])
  })
})

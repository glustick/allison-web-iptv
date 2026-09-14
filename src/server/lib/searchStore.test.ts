import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createSearchStore, type SearchStore } from './searchStore.js'
import type { IndexRow } from './providerLists.js'

let dir: string
let store: SearchStore

const row = (streamId: number, name: string, kind: 'live' | 'movie' | 'series' = 'live', category: string | null = 'UK'): IndexRow => ({
  kind,
  streamId,
  name,
  category,
  icon: null
})

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'allison-search-'))
  store = createSearchStore({ dataDir: dir })
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('searchStore', () => {
  it('indexes a catalogue and searches it by name', () => {
    store.replaceKind('live', [row(1, 'Sky Sports 1 HD'), row(2, 'BBC One'), row(3, 'Discovery Channel')])

    expect(store.search('discovery').map((hit) => hit.name)).toEqual(['Discovery Channel'])
    expect(store.stats()).toMatchObject({ live: 3, movie: 0, series: 0, total: 3 })
    expect(store.stats().indexedAt).not.toBeNull()
  })

  it('folds number words and keeps visible words searchable', () => {
    store.replaceKind('live', [row(1, 'Sky Sports 1 HD'), row(2, 'BBC One London'), row(3, 'Sky Sports News')])
    store.replaceKind('movie', [row(4, 'Discovery Channel', 'movie')])
    expect(store.search('discovery channel').map((hit) => hit.name)).toEqual(['Discovery Channel'])

    // "one" folds to "1"; unlike guide matching, packaging words stay searchable because people
    // type the words they can see.
    expect(store.search('sky sports one')[0]?.name).toBe('Sky Sports 1 HD')
    expect(store.search('bbc one')[0]?.name).toBe('BBC One London')
    expect(store.search('sky sports').map((hit) => hit.name)).toContain('Sky Sports News')
  })

  it('requires every query word to match, and ranks the best candidate first', () => {
    store.replaceKind('live', [row(1, 'Sky Sports F1'), row(2, 'Sky Sports 1'), row(3, 'Sky Sports News')])

    // "f1" alone finds the F1 channel; "f1 news" matches nothing because no name has both.
    expect(store.search('f1').map((hit) => hit.name)).toEqual(['Sky Sports F1'])
    expect(store.search('f1 news')).toEqual([])
    expect(store.search('sports sky').length).toBe(3)
  })

  it('searches across kinds, filters by kind, and respects the limit', () => {
    store.replaceKind('live', [row(1, 'Batman Live', 'live')])
    store.replaceKind('movie', [row(2, 'Batman Begins', 'movie'), row(3, 'Batman Returns', 'movie')])
    store.replaceKind('series', [row(4, 'Batman: The Animated Series', 'series')])

    const all = store.search('batman', 10)
    expect(all.map((hit) => hit.kind).sort()).toEqual(['live', 'movie', 'movie', 'series'])
    expect(store.search('batman', 10, 'movie').map((hit) => hit.name)).toEqual(['Batman Begins', 'Batman Returns'])
    expect(store.search('batman', 1)).toHaveLength(1)
  })

  it('replaces a kind wholesale, so a provider re-numbering cannot leave stale rows', () => {
    store.replaceKind('live', [row(1, 'Old Channel')])
    store.replaceKind('live', [row(9, 'New Channel')])
    expect(store.search('channel').map((hit) => hit.name)).toEqual(['New Channel'])
    expect(store.stats().live).toBe(1)
  })

  it('reports staleness and can be cleared', () => {
    expect(store.isStale(1000)).toBe(true)
    store.replaceKind('live', [row(1, 'Any')])
    expect(store.isStale(60_000)).toBe(false)
    store.clear()
    expect(store.stats().total).toBe(0)
    expect(store.isStale(60_000)).toBe(true)
  })

  it('returns nothing for an empty or punctuation-only query instead of everything', () => {
    store.replaceKind('live', [row(1, 'Anything')])
    expect(store.search('')).toEqual([])
    expect(store.search('   ')).toEqual([])
    expect(store.search('!!!')).toEqual([])
  })
})

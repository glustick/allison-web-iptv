import { describe, expect, it } from 'vitest'
import { countHits, filterHits } from './searchFilter'

const hits = [
  { kind: 'live', name: 'Sky Sports' },
  { kind: 'movie', name: 'Heat' },
  { kind: 'live', name: 'Sky News' },
  { kind: 'series', name: 'Slow Horses' }
]

describe('search filters', () => {
  it('narrows to one kind, and All keeps everything', () => {
    expect(filterHits(hits, 'live').map((h) => h.name)).toEqual(['Sky Sports', 'Sky News'])
    expect(filterHits(hits, 'movie')).toHaveLength(1)
    expect(filterHits(hits, 'all')).toHaveLength(4)
  })

  it('counts each kind for the chips', () => {
    expect(countHits(hits)).toEqual({ all: 4, live: 2, movie: 1, series: 1 })
    expect(countHits([])).toEqual({ all: 0, live: 0, movie: 0, series: 0 })
  })
})

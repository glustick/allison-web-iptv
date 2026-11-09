import { describe, expect, it } from 'vitest'
import { firstUnwatchedEpisode, nextEpisode, orderedEpisodes } from './nextEpisode'

const ep = (id: string, season: number, num: number) => ({ id, season, episode_num: num, title: `S${season}E${num}` })

const episodes = {
  '2': [ep('a', 2, 1), ep('b', 2, 2)],
  '1': [ep('c', 1, 1), ep('d', 1, 2)],
  '3': []
}

describe('the next episode', () => {
  it('follows the season order, not the object key order', () => {
    expect(nextEpisode(episodes, { id: 'c' })?.id).toBe('d')
  })

  it('moves to the next episode within a season', () => {
    expect(nextEpisode(episodes, { id: 'a' })?.id).toBe('b')
  })

  it('crosses into the next season that has episodes, skipping an empty one', () => {
    expect(nextEpisode(episodes, { id: 'b' })).toBeNull() // season 3 is empty
    expect(nextEpisode({ ...episodes, '4': [ep('z', 4, 1)] }, { id: 'b' })?.id).toBe('z')
  })

  it('returns nothing at the end, and nothing for an unknown episode', () => {
    expect(nextEpisode(episodes, { id: 'zzz' })).toBeNull()
    expect(nextEpisode({}, { id: 'a' })).toBeNull()
  })

  it('tolerates an unsorted episode list inside a season', () => {
    expect(nextEpisode({ '1': [ep('d', 1, 2), ep('c', 1, 1)] }, { id: 'c' })?.id).toBe('d')
  })
})

describe('where the viewer actually is (v0.99.0)', () => {
  it('flattens every season in watch order', () => {
    expect(orderedEpisodes(episodes).map((e) => e.id)).toEqual(['c', 'd', 'a', 'b'])
  })

  it('finds the first episode not marked watched', () => {
    expect(firstUnwatchedEpisode(episodes, ['c'])?.id).toBe('d')
    expect(firstUnwatchedEpisode(episodes, ['c', 'd'])?.id).toBe('a')
  })

  it('crosses a season boundary once the season is done', () => {
    expect(firstUnwatchedEpisode(episodes, ['c', 'd', 'a'])?.id).toBe('b')
  })

  it('answers null when the whole show is watched — a finished show has nowhere to continue', () => {
    expect(firstUnwatchedEpisode(episodes, ['c', 'd', 'a', 'b'])).toBeNull()
  })

  it('starts at the first episode when nothing is watched, and tolerates unknown ids', () => {
    expect(firstUnwatchedEpisode(episodes, [])?.id).toBe('c')
    expect(firstUnwatchedEpisode(episodes, ['nope'])?.id).toBe('c')
    expect(firstUnwatchedEpisode({}, [])).toBeNull()
  })
})

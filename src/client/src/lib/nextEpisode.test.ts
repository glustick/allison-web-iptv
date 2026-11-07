import { describe, expect, it } from 'vitest'
import { nextEpisode } from './nextEpisode'

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

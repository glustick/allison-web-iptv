import { describe, it, expect } from 'vitest'
import { fixtureMatchKey, indexFixturesByMatch, type ApiFootballFixture } from './sportsFixtures'

function fixture(partial: Partial<ApiFootballFixture> & { homeTeam: string; awayTeam: string }): ApiFootballFixture {
  return {
    id: 1,
    kickoffMs: Date.parse('2026-09-28T14:00:00Z'),
    league: 'Premier League',
    country: 'England',
    round: 'Regular Season - 6',
    homeGoals: null,
    awayGoals: null,
    live: false,
    finished: false,
    statusLong: 'Not Started',
    ...partial
  }
}

describe('fixtureMatchKey', () => {
  it('ignores home/away order — the same match is one key', () => {
    const a = fixtureMatchKey({ homeTeam: 'Sunderland', awayTeam: 'Newcastle United' })
    const b = fixtureMatchKey({ homeTeam: 'Newcastle United', awayTeam: 'Sunderland' })
    expect(a).toBe(b)
  })

  it('applies the provider parser\'s own team rules, so club suffixes drop out', () => {
    // The provider writes "Hull City AFC" where the feed writes "Hull City" — the same match.
    expect(fixtureMatchKey({ homeTeam: 'Hull City AFC', awayTeam: 'Sunderland' })).toBe(
      fixtureMatchKey({ homeTeam: 'Hull City', awayTeam: 'Sunderland' })
    )
  })

  it('keeps different matches apart', () => {
    expect(fixtureMatchKey({ homeTeam: 'Sunderland', awayTeam: 'Newcastle United' })).not.toBe(
      fixtureMatchKey({ homeTeam: 'Sunderland', awayTeam: 'Middlesbrough' })
    )
  })
})

describe('indexFixturesByMatch', () => {
  it('indexes a day\'s fixtures by match key', () => {
    const index = indexFixturesByMatch([
      fixture({ id: 7, homeTeam: 'Sunderland', awayTeam: 'Newcastle United' })
    ])
    expect(index.get(fixtureMatchKey({ homeTeam: 'Newcastle United', awayTeam: 'Sunderland' }))?.id).toBe(7)
  })

  it('lets a live entry win a duplicate, since it is the one carrying a score', () => {
    const index = indexFixturesByMatch([
      fixture({ id: 1, homeTeam: 'Sunderland', awayTeam: 'Newcastle United' }),
      fixture({ id: 2, homeTeam: 'Sunderland', awayTeam: 'Newcastle United', live: true, homeGoals: 0, awayGoals: 1 })
    ])
    const entry = index.get(fixtureMatchKey({ homeTeam: 'Sunderland', awayTeam: 'Newcastle United' }))
    expect(entry?.id).toBe(2)
    expect(entry?.live).toBe(true)
  })
})

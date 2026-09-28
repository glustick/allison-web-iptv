import { describe, it, expect } from 'vitest'
import {
  channelsMentioningTeams,
  fixtureMatchKey,
  indexFixturesByMatch,
  loosePairMatches,
  matchFixturesToGames,
  sideLooselyMatches,
  type ApiFootballFixture
} from './sportsFixtures'
import type { LiveStream } from './types'

function channel(name: string, num = 1): LiveStream {
  return {
    num,
    name,
    stream_type: 'live',
    stream_id: num,
    stream_icon: '',
    epg_channel_id: null,
    added: '',
    category_id: '1',
    custom_sid: null,
    tv_archive: 0,
    direct_source: '',
    tv_archive_duration: 0
  }
}

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

describe('sideLooselyMatches', () => {
  it('accepts a club whose feed name is a prefix of the provider\'s', () => {
    expect(sideLooselyMatches('newcastle', 'newcastle united')).toBe(true)
    expect(sideLooselyMatches('brighton', 'brighton & hove albion')).toBe(true)
  })

  it('refuses two clubs that merely share a city', () => {
    expect(sideLooselyMatches('manchester united', 'manchester city')).toBe(false)
  })

  it('never lets a lone generic word carry a match', () => {
    expect(sideLooselyMatches('united', 'newcastle united')).toBe(false)
    expect(sideLooselyMatches('city', 'hull city')).toBe(false)
    // …while an identical key still agrees with itself, generic or not.
    expect(sideLooselyMatches('united', 'united')).toBe(true)
  })
})

describe('loosePairMatches', () => {
  it('ignores home/away order', () => {
    expect(loosePairMatches('newcastle vs sunderland', 'sunderland vs newcastle united')).toBe(true)
  })
})

describe('matchFixturesToGames', () => {
  it('pairs by exact key first', () => {
    const pairing = matchFixturesToGames(
      [fixture({ id: 9, homeTeam: 'Sunderland', awayTeam: 'Newcastle United' })],
      [{ key: 'g1', pairKey: fixtureMatchKey({ homeTeam: 'Newcastle United', awayTeam: 'Sunderland' }) }]
    )
    expect(pairing.byGame.get('g1')?.id).toBe(9)
    expect([...pairing.matchedIds]).toEqual([9])
  })

  it('falls back to a loose match when the exact key misses', () => {
    // The feed says "Newcastle United"; the provider's own name normalizes to "newcastle".
    const pairing = matchFixturesToGames(
      [fixture({ id: 4, homeTeam: 'Sunderland', awayTeam: 'Newcastle United' })],
      [{ key: 'g1', pairKey: 'newcastle vs sunderland' }]
    )
    expect(pairing.byGame.get('g1')?.id).toBe(4)
    expect([...pairing.matchedIds]).toEqual([4])
  })

  it('refuses an ambiguous loose match, leaving the fixture unclaimed', () => {
    const pairing = matchFixturesToGames(
      [
        fixture({ id: 1, homeTeam: 'Newcastle United', awayTeam: 'Sunderland' }),
        fixture({ id: 2, homeTeam: 'Newcastle United', awayTeam: 'Sunderland AFC' })
      ],
      [{ key: 'g1', pairKey: 'newcastle vs sunderland' }]
    )
    expect(pairing.byGame.has('g1')).toBe(false)
    expect(pairing.matchedIds.size).toBe(0)
  })

  it('does not spend one fixture on two games', () => {
    const pairing = matchFixturesToGames(
      [fixture({ id: 5, homeTeam: 'Sunderland', awayTeam: 'Newcastle United' })],
      [
        { key: 'g1', pairKey: 'newcastle vs sunderland' },
        { key: 'g2', pairKey: 'newcastle vs sunderland' }
      ]
    )
    expect(pairing.matchedIds.size).toBe(1)
  })
})

describe('channelsMentioningTeams', () => {
  it('finds the channels that name either team, best match first', () => {
    const streams = [
      channel('668 Sky Sports Main Event UHD', 1),
      channel('Soccer01: Sunderland vs Newcastle ( Sky Sports Feed )', 2),
      channel('Sunderland TV', 3)
    ]
    const hits = channelsMentioningTeams(streams, 'Sunderland', 'Newcastle United')
    expect(hits.map((c) => c.stream_id)).toEqual([2, 3])
  })

  it('ignores generic club words, so it cannot match half the catalogue', () => {
    const streams = [channel('Manchester United TV', 1), channel('Hull City Channel', 2)]
    // "United" and "City" are stopwords; "Manchester"/"Hull" are not the teams asked about…
    expect(channelsMentioningTeams(streams, 'Liverpool', 'Everton')).toHaveLength(0)
  })
})

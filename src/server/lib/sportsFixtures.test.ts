import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { EventEmitter } from 'events'
import { Writable } from 'stream'
import { createServer, type Server } from 'http'
import type { AddressInfo } from 'net'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  createSportsFixturesService,
  describeInBandError,
  fixturesUrl,
  normaliseGame,
  normaliseRaces,
  normalizeFixture,
  parseFixturesResponse,
  parseGamesResponse,
  racesForDate,
  refreshMotorSportFlags,
  sportApiFor,
  sportUrl,
  SPORT_APIS,
  SPORT_API_IDS
} from './sportsFixtures.js'
import { createSportsFixturesStore, type SportsFixturesStore } from './sportsFixturesStore.js'

// The api-football layer is tested two ways, following this repo's own convention (see
// proxyServer.test.ts / nodeUpstreamRequest.test.ts): the response shape as pure units, and the
// fetch itself against a real http.Server standing in for the feed — which is what proves the key
// actually travels as a header rather than only in a comment.

const servers: Server[] = []
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
  )
})

/** One api-football /fixtures entry, shaped exactly as v3 returns it. */
function rawFixture(overrides: { short?: string; id?: number; home?: number | null; away?: number | null } = {}): unknown {
  return {
    fixture: {
      id: overrides.id ?? 1180921,
      date: '2026-09-28T14:00:00+00:00',
      status: { short: overrides.short ?? 'NS', long: 'Not Started' }
    },
    league: { name: 'Premier League', country: 'England', round: 'Regular Season - 6', season: 2026 },
    teams: { home: { name: 'Sunderland' }, away: { name: 'Newcastle' } },
    goals: { home: overrides.home ?? null, away: overrides.away ?? null }
  }
}

describe('fixturesUrl', () => {
  it('pins the api-football host and interpolates only the date', () => {
    const url = new URL(fixturesUrl('2026-09-28'))
    expect(url.origin).toBe('https://v3.football.api-sports.io')
    expect(url.pathname).toBe('/fixtures')
    expect(url.searchParams.get('date')).toBe('2026-09-28')
  })
})

describe('describeInBandError', () => {
  it('treats api-football\'s empty containers as "no error"', () => {
    expect(describeInBandError([])).toBeNull()
    expect(describeInBandError({})).toBeNull()
    expect(describeInBandError(null)).toBeNull()
    expect(describeInBandError(undefined)).toBeNull()
  })

  it('reads the object, array and string shapes it actually returns', () => {
    expect(describeInBandError({ token: 'Invalid API key' })).toBe('Invalid API key')
    expect(describeInBandError({ rateLimit: 'Too many requests' })).toBe('Too many requests')
    expect(describeInBandError(['bad request'])).toBe('bad request')
    expect(describeInBandError('nope')).toBe('nope')
  })
})

describe('parseFixturesResponse', () => {
  it('normalizes a scheduled fixture and keeps null goals as null', () => {
    const result = parseFixturesResponse(JSON.stringify({ results: 1, errors: [], response: [rawFixture()] }))
    expect(result.error).toBeNull()
    expect(result.fixtures).toHaveLength(1)
    const fixture = result.fixtures[0]
    expect(fixture.homeTeam).toBe('Sunderland')
    expect(fixture.awayTeam).toBe('Newcastle')
    expect(fixture.league).toBe('Premier League')
    expect(fixture.live).toBe(false)
    expect(fixture.finished).toBe(false)
    expect(fixture.homeGoals).toBeNull()
    expect(fixture.kickoffMs).toBe(Date.parse('2026-09-28T14:00:00+00:00'))
  })

  it('marks an in-play fixture live and a finished one finished, with its score', () => {
    const inPlay = parseFixturesResponse(
      JSON.stringify({ errors: [], response: [rawFixture({ short: '2H', home: 0, away: 0 })] })
    ).fixtures[0]
    expect(inPlay.live).toBe(true)
    expect(inPlay.finished).toBe(false)
    expect([inPlay.homeGoals, inPlay.awayGoals]).toEqual([0, 0])

    const done = parseFixturesResponse(
      JSON.stringify({ errors: [], response: [rawFixture({ short: 'FT', home: 2, away: 1 })] })
    ).fixtures[0]
    expect(done.finished).toBe(true)
    expect(done.live).toBe(false)
  })

  it('surfaces an in-band error instead of an empty list', () => {
    const result = parseFixturesResponse(JSON.stringify({ errors: { token: 'Invalid API key' }, response: [] }))
    expect(result.error).toBe('Invalid API key')
    expect(result.fixtures).toHaveLength(0)
  })

  it('says so when the body is not JSON at all', () => {
    expect(parseFixturesResponse('<html>nope</html>').error).toMatch(/not JSON/)
  })

  it('drops entries with no usable id', () => {
    const result = parseFixturesResponse(JSON.stringify({ errors: [], response: [{ fixture: {}, teams: {} }] }))
    expect(result.fixtures).toHaveLength(0)
  })
})

describe('normalizeFixture', () => {
  it('leaves an unparseable date null rather than inventing an instant', () => {
    expect(
      normalizeFixture({ fixture: { id: 1, date: 'not a date', status: { short: 'NS' } } }).kickoffMs
    ).toBeNull()
  })
})

describe('the sibling sport hosts', () => {
  // Shapes taken from live responses on 2026-09-28, because the hosts genuinely differ: basketball
  // nests the score under `total` with per-quarter detail, hockey puts a plain number there.
  it('reads basketball, whose score is nested', () => {
    const fixture = normaliseGame(
      {
        id: 1,
        date: '2026-09-28T01:00:00+00:00',
        status: { short: 'FT', long: 'Game Finished' },
        league: { name: 'NBA W', country: null },
        teams: { home: { name: 'Golden State Valkyries W' }, away: { name: 'Dallas Wings W' } },
        scores: { home: { total: 104 }, away: { total: 96 } }
      },
      'basketball'
    )
    expect(fixture).toMatchObject({
      sport: 'basketball',
      league: 'NBA W',
      homeGoals: 104,
      awayGoals: 96,
      finished: true,
      live: false
    })
  })

  it('reads hockey, whose score is a plain number', () => {
    const fixture = normaliseGame(
      {
        id: 2,
        date: '2026-09-28T18:00:00+00:00',
        status: { short: 'FT', long: 'Finished' },
        league: { name: 'NHL' },
        teams: { home: { name: 'Bruins' }, away: { name: 'Rangers' } },
        scores: { home: 5, away: 3 }
      },
      'ice-hockey'
    )
    expect(fixture).toMatchObject({ sport: 'ice-hockey', homeGoals: 5, awayGoals: 3, finished: true })
  })

  it('keeps a missing score null rather than inventing 0-0', () => {
    const fixture = normaliseGame(
      {
        id: 3,
        date: '2026-09-28T18:00:00+00:00',
        status: { short: 'NS', long: 'Not Started' },
        league: { name: 'NHL' },
        teams: { home: { name: 'A' }, away: { name: 'B' } },
        scores: { home: null, away: null }
      },
      'ice-hockey'
    )
    expect(fixture.homeGoals).toBeNull()
    expect(fixture.awayGoals).toBeNull()
  })

  it('parses the /games envelope, in-band errors included', () => {
    const ok = parseGamesResponse(
      JSON.stringify({
        errors: [],
        response: [
          {
            id: 9,
            date: '2026-09-28T18:00:00+00:00',
            league: { name: 'NHL' },
            teams: { home: { name: 'A' }, away: { name: 'B' } },
            scores: { home: 1, away: 2 }
          }
        ]
      }),
      'ice-hockey'
    )
    expect(ok.error).toBeNull()
    expect(ok.fixtures[0]).toMatchObject({ sport: 'ice-hockey', homeGoals: 1, awayGoals: 2 })

    const refused = parseGamesResponse(
      JSON.stringify({ errors: { token: 'Invalid API key' }, response: [] }),
      'ice-hockey'
    )
    expect(refused.error).toBe('Invalid API key')
  })
})

describe('the catalogue', () => {
  it('carries every sport the operator named, each on its own api-sports host', () => {
    // The ask (2026-09-30): "AFL baseball basketball formula 1 NBA NFL are all missing api calls."
    // Baseball and basketball were already wired (v0.61.5); the missing three are the point here.
    expect(SPORT_API_IDS).toEqual([
      'football',
      'basketball',
      'american-football',
      'baseball',
      'ice-hockey',
      'aussie-rules',
      'rugby',
      'handball',
      'volleyball',
      'fighting',
      'motorsport'
    ])
    expect(sportApiFor('american-football')).toMatchObject({ host: 'v1.american-football.api-sports.io', path: '/games' })
    expect(sportApiFor('aussie-rules')).toMatchObject({ host: 'v1.afl.api-sports.io', path: '/games' })
    expect(sportApiFor('motorsport')).toMatchObject({ host: 'v1.formula-1.api-sports.io', path: '/races' })
  })

  it('resolves MMA onto the fighting feed', () => {
    expect(sportApiFor('mma')?.sport).toBe('fighting')
    expect(sportApiFor('ufc')?.sport).toBe('fighting')
    expect(sportApiFor('handball')).toMatchObject({ host: 'v1.handball.api-sports.io', path: '/games' })
    expect(sportApiFor('volleyball')).toMatchObject({ host: 'v1.volleyball.api-sports.io', path: '/games' })
  })

  it('resolves the everyday names onto the right host, with NBA on basketball — not queried twice', () => {
    expect(sportApiFor('nba')?.sport).toBe('basketball')
    expect(sportApiFor('nfl')?.sport).toBe('american-football')
    expect(sportApiFor('afl')?.sport).toBe('aussie-rules')
    expect(sportApiFor('f1')?.sport).toBe('motorsport')
    expect(sportApiFor('formula-1')?.sport).toBe('motorsport')
    expect(sportApiFor('hockey')?.sport).toBe('ice-hockey')
    expect(sportApiFor('tennis')).toBeNull() // a sport the key has no host for costs nothing
  })

  it('builds the season query for formula-1 and the date query for everyone else', () => {
    expect(sportUrl(sportApiFor('motorsport')!, '2026-10-01')).toBe('https://v1.formula-1.api-sports.io/races?season=2026')
    expect(sportUrl(sportApiFor('basketball')!, '2026-10-01')).toBe('https://v1.basketball.api-sports.io/games?date=2026-10-01')
  })

  it('reads NFL and AFL through the same /games normaliser as their siblings', () => {
    const nfl = normaliseGame(
      {
        id: 4411,
        date: '2026-10-01T17:00:00+00:00',
        status: { short: 'Q1', long: 'In Progress' },
        league: { name: 'NFL', country: 'USA' },
        teams: { home: { name: 'Chiefs' }, away: { name: 'Ravens' } },
        scores: { home: 10, away: 7 }
      },
      'american-football'
    )
    expect(nfl).toMatchObject({ sport: 'american-football', league: 'NFL', homeGoals: 10, awayGoals: 7, live: true })

    const afl = normaliseGame(
      {
        id: 5522,
        date: '2026-10-02T09:30:00+00:00',
        status: { short: 'FT', long: 'Game Finished' },
        league: { name: 'AFL', country: 'Australia' },
        teams: { home: { name: 'Collingwood' }, away: { name: 'Carlton' } },
        scores: { home: 97, away: 84 }
      },
      'aussie-rules'
    )
    expect(afl).toMatchObject({ sport: 'aussie-rules', finished: true, homeGoals: 97 })
  })
})

describe('formula-1 races', () => {
  const body = JSON.stringify({
    errors: [],
    response: [
      {
        id: 34,
        name: 'British Grand Prix',
        competition: { name: 'Formula 1' },
        circuit: { name: 'Silverstone Circuit', country: { name: 'England' } },
        sessions: {
          fp1: '2026-10-01T10:30:00+00:00',
          qualifying: '2026-10-01T14:00:00+00:00',
          race: '2026-10-02T13:00:00+00:00'
        }
      }
    ]
  })

  it('turns each session into a fixture with its own kickoff, and names the day it lands on', () => {
    const season = normaliseRaces(body)
    expect(season.error).toBeNull()
    expect(season.fixtures.map((fixture) => fixture.round)).toEqual(['Practice 1', 'Qualifying', 'Race'])
    expect(season.fixtures[0]).toMatchObject({
      sport: 'motorsport',
      homeTeam: 'British Grand Prix',
      awayTeam: 'Practice 1',
      country: 'England',
      league: 'Formula 1',
      kickoffMs: Date.parse('2026-10-01T10:30:00+00:00')
    })
    // Distinct ids per session of the same race.
    expect(new Set(season.fixtures.map((fixture) => fixture.id)).size).toBe(3)

    const friday = racesForDate(season, '2026-10-01')
    expect(friday.fixtures.map((fixture) => fixture.round)).toEqual(['Practice 1', 'Qualifying'])
    const saturday = racesForDate(season, '2026-10-02')
    expect(saturday.fixtures.map((fixture) => fixture.round)).toEqual(['Race'])
    expect(racesForDate(season, '2026-10-03').fixtures).toHaveLength(0)
  })

  it('derives live and finished from the clock, with a longer window for the race itself', () => {
    const season = normaliseRaces(body)
    const duringQuali = refreshMotorSportFlags(season.fixtures, Date.parse('2026-10-01T14:30:00+00:00'))
    expect(duringQuali.find((fixture) => fixture.round === 'Qualifying')?.live).toBe(true)
    expect(duringQuali.find((fixture) => fixture.round === 'Practice 1')?.finished).toBe(true)
    // The race runs two hours, not one.
    const duringRace = refreshMotorSportFlags(season.fixtures, Date.parse('2026-10-02T14:30:00+00:00'))
    expect(duringRace.find((fixture) => fixture.round === 'Race')?.live).toBe(true)
    const after = refreshMotorSportFlags(season.fixtures, Date.parse('2026-10-02T16:00:00+00:00'))
    expect(after.find((fixture) => fixture.round === 'Race')?.finished).toBe(true)
  })

  it('surfaces an in-band error like every other host', () => {
    expect(normaliseRaces(JSON.stringify({ errors: { token: 'Invalid API key' }, response: [] })).error).toBe('Invalid API key')
  })
})

describe('the persisted fixture cache', () => {
  let store: SportsFixturesStore
  let dir: string

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  async function gameOrigin(counters: { hits: number; url?: string }): Promise<string> {
    const server = createServer((req, res) => {
      counters.hits += 1
      counters.url = req.url
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          errors: [],
          response: [
            {
              id: counters.hits,
              date: '2026-10-01T18:00:00+00:00',
              status: { short: 'NS', long: 'Not Started' },
              league: { name: 'NBA', country: 'USA' },
              teams: { home: { name: 'Celtics' }, away: { name: 'Lakers' } },
              scores: { home: null, away: null }
            }
          ]
        })
      )
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const { port } = server.address() as AddressInfo
    return `http://127.0.0.1:${port}`
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'allison-fixtures-svc-'))
    store = createSportsFixturesStore({ dataDir: dir })
  })

  it('serves a restart from storage without spending another request', async () => {
    const counters = { hits: 0 }
    const origin = await gameOrigin(counters)
    let clock = Date.parse('2026-10-01T18:00:00Z') // the day itself
    const first = createSportsFixturesService({ origin, store, now: () => clock })
    await first.getFixturesForSports('2026-10-01', 'k', ['basketball'])
    expect(counters.hits).toBe(1)

    // A fresh process, memory empty, same store: the answer is already paid for.
    clock += 10 * 60_000
    const restarted = createSportsFixturesService({ origin, store, now: () => clock })
    const served = await restarted.getFixturesForSports('2026-10-01', 'k', ['basketball'])
    expect(counters.hits).toBe(1)
    expect(served.fixtures[0]).toMatchObject({ homeTeam: 'Celtics' })
  })

  it('never re-asks a past day whose results are final, for its whole stored life', async () => {
    const counters = { hits: 0 }
    const origin = await gameOrigin(counters)
    let clock = Date.parse('2026-09-28T12:00:00Z') // asking about a finished day, days later
    const service = createSportsFixturesService({ origin, store, now: () => clock })
    await service.getFixturesForSports('2026-09-20', 'k', ['basketball'])
    expect(counters.hits).toBe(1)

    // Days pass; the stored answer is final and keeps serving.
    clock += 3 * 24 * 60 * 60_000
    const again = await service.getFixturesForSports('2026-09-20', 'k', ['basketball'])
    expect(counters.hits).toBe(1)
    expect(again.fixtures[0]).toMatchObject({ homeTeam: 'Celtics' })
  })

  it('keeps today refreshing on the idle cadence — storage does not freeze a live day', async () => {
    const counters = { hits: 0 }
    const origin = await gameOrigin(counters)
    let clock = Date.parse('2026-10-01T12:00:00Z')
    const service = createSportsFixturesService({ origin, store, now: () => clock })
    await service.getFixturesForSports('2026-10-01', 'k', ['basketball'])
    expect(counters.hits).toBe(1)

    // A later process, more than an hour on: the day is today, so it is asked again.
    clock += 90 * 60_000
    const later = createSportsFixturesService({ origin, store, now: () => clock })
    await later.getFixturesForSports('2026-10-01', 'k', ['basketball'])
    expect(counters.hits).toBe(2)
  })

  it('carries the request count across restarts, so the ceiling stays honest', async () => {
    const counters = { hits: 0 }
    const origin = await gameOrigin(counters)
    const clock = () => Date.parse('2026-10-01T12:00:00Z')
    // Eighty distinct days, each asked once: every request is spent on a day nobody has stored.
    const first = createSportsFixturesService({ origin, store, now: clock })
    for (let i = 0; i < 80; i += 1) {
      const day = new Date(Date.parse('2026-08-01T00:00:00Z') + i * 24 * 60 * 60_000).toISOString().slice(0, 10)
      await first.getFixturesForSports(day, 'k', ['basketball'])
    }
    expect(counters.hits).toBe(80)

    // The restarted process inherits the spent count and refuses to spend more.
    const restarted = createSportsFixturesService({ origin, store, now: clock })
    const over = await restarted.getFixturesForSports('2026-12-01', 'k', ['basketball'])
    expect(counters.hits).toBe(80)
    expect(over.error).toMatch(/budget/)
  })
})

describe('formula-1 through the service', () => {
  it('fetches a season once and serves each day from it', async () => {
    const counters = { hits: 0, urls: [] as string[] }
    const server = createServer((req, res) => {
      counters.hits += 1
      counters.urls.push(req.url ?? '')
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          errors: [],
          response: [
            {
              id: 34,
              name: 'British Grand Prix',
              competition: { name: 'Formula 1' },
              circuit: { name: 'Silverstone Circuit', country: { name: 'England' } },
              sessions: {
                fp1: '2026-10-01T10:30:00+00:00',
                qualifying: '2026-10-01T14:00:00+00:00',
                race: '2026-10-02T13:00:00+00:00'
              }
            }
          ]
        })
      )
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const { port } = server.address() as AddressInfo
    const origin = `http://127.0.0.1:${port}`

    let clock = Date.parse('2026-10-01T12:00:00Z')
    const service = createSportsFixturesService({ origin, now: () => clock })
    const friday = await service.getFixturesForSports('2026-10-01', 'k', ['motorsport'])
    expect(friday.fixtures.map((fixture) => fixture.round)).toEqual(['Practice 1', 'Qualifying'])
    // Live/finished derived at read time, from the asking clock (12:00): practice over, quali not begun.
    expect(friday.fixtures.find((fixture) => fixture.round === 'Practice 1')?.finished).toBe(true)
    expect(friday.fixtures.find((fixture) => fixture.round === 'Qualifying')?.live).toBe(false)

    // Half an hour into qualifying, the same stored day reads differently — no request spent.
    clock = Date.parse('2026-10-01T14:30:00Z')
    const midQuali = await service.getFixturesForSports('2026-10-01', 'k', ['motorsport'])
    expect(midQuali.fixtures.find((fixture) => fixture.round === 'Qualifying')?.live).toBe(true)
    expect(counters.hits).toBe(1)
    clock = Date.parse('2026-10-01T12:10:00Z')
    const saturday = await service.getFixturesForSports('2026-10-02', 'k', ['motorsport'])
    expect(saturday.fixtures.map((fixture) => fixture.round)).toEqual(['Race'])
    // One season fetch served both days.
    expect(counters.hits).toBe(1)
    expect(counters.urls[0]).toBe('/races?season=2026')
  })
})

describe('every sport asks its own host', () => {
  // The bug this exists for shipped in v0.61.5 and lived until 2026-10-01: the service passed
  // football's origin to every sport's URL builder, so basketball et al asked
  // v3.football.api-sports.io for /games — "The Games endpoint does not exist", then 429s — and
  // only football ever reached its own product. No fake-origin test could see it (a fake origin
  // serves every path happily); this one watches the wire.
  function fakeUpstream(answer: (url: string) => { status: number; body: string }): {
    create: unknown
    seen: string[]
  } {
    const seen: string[] = []
    const create = (opts: { url: string }): unknown => {
      const req = new EventEmitter() as unknown as Record<string, unknown> & EventEmitter
      req.setHeader = (): unknown => undefined
      req.abort = (): unknown => undefined
      req.followRedirect = (): unknown => undefined
      req.end = (): unknown => undefined
      setImmediate(() => {
        seen.push(opts.url)
        const { status, body } = answer(opts.url)
        req.emit('response', {
          statusCode: status,
          headers: {},
          pipe(sink: Writable) {
            sink.write(Buffer.from(body))
            sink.end()
            return sink
          }
        })
      })
      return req
    }
    return { create, seen }
  }

  it('sends each sport to its own api-sports host, football to football alone', async () => {
    const { create, seen } = fakeUpstream(() => ({ status: 200, body: JSON.stringify({ errors: [], response: [] }) }))
    const service = createSportsFixturesService({
      createUpstreamRequest: create as unknown as typeof import('./nodeUpstreamRequest.js').createNodeUpstreamRequest
    })
    const result = await service.getFixturesForSports('2026-10-01', 'k')
    expect(result.error).toBeNull()
    const hosts = seen.map((url) => new URL(url).host)
    expect(new Set(hosts).size).toBe(SPORT_APIS.length)
    expect(hosts.filter((host) => host === 'v3.football.api-sports.io')).toHaveLength(1)
    expect(hosts).toContain('v1.basketball.api-sports.io')
    expect(hosts).toContain('v1.american-football.api-sports.io')
    expect(hosts).toContain('v1.afl.api-sports.io')
    expect(hosts).toContain('v1.handball.api-sports.io')
    expect(hosts).toContain('v1.mma.api-sports.io')
    expect(hosts).toContain('v1.formula-1.api-sports.io')
  })

  it('does not hang a failing sport over a day that answered — F1 plan limits stay quiet', async () => {
    const { create } = fakeUpstream((url) => {
      if (url.includes('formula-1')) {
        return { status: 200, body: JSON.stringify({ errors: { season: 'Free plans do not have access to this season, try from 2022 to 2024.' }, response: [] }) }
      }
      if (url.includes('v3.football')) {
        return { status: 200, body: JSON.stringify({ errors: [], response: [rawFixture()] }) }
      }
      return {
        status: 200,
        body: JSON.stringify({
          errors: [],
          response: [
            { id: 7, date: '2026-10-01T18:00:00+00:00', league: { name: 'NBA' }, teams: { home: { name: 'A' }, away: { name: 'B' } }, scores: { home: 1, away: 2 } }
          ]
        })
      }
    })
    const service = createSportsFixturesService({
      createUpstreamRequest: create as unknown as typeof import('./nodeUpstreamRequest.js').createNodeUpstreamRequest
    })
    const result = await service.getFixturesForSports('2026-10-01', 'k')
    expect(result.fixtures).toHaveLength(SPORT_APIS.length - 1) // everyone but F1 answered one game
    expect(result.error).toBeNull()
  })

  it('holds formula-1 plan refusals for the season TTL instead of re-billing every poll', async () => {
    let racesCalls = 0
    const { create } = fakeUpstream((url) => {
      if (url.includes('formula-1')) {
        racesCalls += 1
        return { status: 200, body: JSON.stringify({ errors: { season: 'Free plans do not have access to this season, try from 2022 to 2024.' }, response: [] }) }
      }
      return { status: 200, body: JSON.stringify({ errors: [], response: [] }) }
    })
    let clock = Date.parse('2026-10-01T12:00:00Z')
    const service = createSportsFixturesService({
      createUpstreamRequest: create as unknown as typeof import('./nodeUpstreamRequest.js').createNodeUpstreamRequest,
      now: () => clock
    })
    await service.getFixturesForSports('2026-10-01', 'k', ['motorsport'])
    // A later poll: the day's error entry has aged out of memory (60s) — the *season* refusal is
    // what must still be held, so no second request goes out.
    clock += 10 * 60_000
    await service.getFixturesForSports('2026-10-01', 'k', ['motorsport'])
    expect(racesCalls).toBe(1)
  })
})

describe('quota discipline', () => {
  // The plan is a free one: `status` reports `limit_day: 100`, and the Sports tab polls while it is
  // open. These pin the two rules that keep the app inside that allowance — and that adding more
  // sports (which multiplies the request count) depends on.
  async function liveOrigin(counters: { hits: number }, live: boolean): Promise<string> {
    const server = createServer((_req, res) => {
      counters.hits += 1
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          errors: [],
          response: [rawFixture({ short: live ? '2H' : 'NS', home: 0, away: 0 })]
        })
      )
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const { port } = server.address() as AddressInfo
    return `http://127.0.0.1:${port}`
  }

  it('keeps a day with nothing in play far longer than a live one', async () => {
    // Idle: one fetch, still cached six minutes later, refreshed once the hour is up.
    const idle = { hits: 0 }
    const idleOrigin = await liveOrigin(idle, false)
    let idleClock = Date.parse('2026-09-28T18:00:00Z')
    const idleService = createSportsFixturesService({ origin: idleOrigin, now: () => idleClock })
    await idleService.getFixtures('2026-09-28', 'k')
    idleClock += 6 * 60_000
    await idleService.getFixtures('2026-09-28', 'k')
    expect(idle.hits).toBe(1)
    idleClock += 55 * 60_000
    await idleService.getFixtures('2026-09-28', 'k')
    expect(idle.hits).toBe(2)

    // Live: the same calls refetch on the short cadence, because a score that is six minutes old is
    // not a score — that is what the five-minute window is for, and why the guard exists elsewhere.
    const live = { hits: 0 }
    const liveFeed = await liveOrigin(live, true)
    let liveClock = Date.parse('2026-09-28T18:00:00Z')
    const liveService = createSportsFixturesService({ origin: liveFeed, now: () => liveClock })
    await liveService.getFixtures('2026-09-28', 'k')
    liveClock += 6 * 60_000
    await liveService.getFixtures('2026-09-28', 'k')
    expect(live.hits).toBe(2)
  })

  it('stops spending requests once the daily allowance is gone, and says so', async () => {
    const counters = { hits: 0 }
    const origin = await liveOrigin(counters, false)
    const service = createSportsFixturesService({ origin, now: () => Date.parse('2026-09-28T18:00:00Z') })
    for (let i = 0; i < 80; i += 1) {
      service.clearCache()
      await service.getFixtures('2026-09-28', 'k')
    }
    expect(counters.hits).toBe(80)
    expect(service.budget().remaining).toBe(0)

    // Over budget: no request is spent, and the caller is told why rather than given a silence.
    service.clearCache()
    const over = await service.getFixtures('2026-09-28', 'k')
    expect(counters.hits).toBe(80)
    expect(over.error).toMatch(/budget/)
  })
})

describe('getFixtures against a real origin', () => {
  async function startOrigin(handler: (headers: Record<string, string | string[] | undefined>) => { status: number; body: string }): Promise<string> {
    const server = createServer((req, res) => {
      const { status, body } = handler(req.headers)
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(body)
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const { port } = server.address() as AddressInfo
    return `http://127.0.0.1:${port}`
  }

  it('sends the key as the x-apisports-key header and returns the fixtures', async () => {
    let seenKey: string | undefined
    let hits = 0
    const origin = await startOrigin((headers) => {
      hits += 1
      seenKey = headers['x-apisports-key'] as string | undefined
      return { status: 200, body: JSON.stringify({ errors: [], response: [rawFixture({ short: '2H', home: 1, away: 0 })] }) }
    })
    const service = createSportsFixturesService({ origin })
    const result = await service.getFixtures('2026-09-28', 'secret-key-123')
    expect(result.error).toBeNull()
    expect(result.fixtures[0].live).toBe(true)
    expect(result.fixtures[0].homeGoals).toBe(1)
    expect(seenKey).toBe('secret-key-123')
    expect(hits).toBe(1)

    // A second call inside the TTL is served from the cache, not the origin (quota matters).
    await service.getFixtures('2026-09-28', 'secret-key-123')
    expect(hits).toBe(1)
  })

  it('does not cache a failure for the full window, so a corrected key takes effect', async () => {
    let body = JSON.stringify({ errors: { token: 'Invalid API key' }, response: [] })
    const origin = await startOrigin(() => ({ status: 200, body }))
    const service = createSportsFixturesService({ origin, cacheTtlMs: 5 * 60_000 })
    expect((await service.getFixtures('2026-09-28', 'bad')).error).toBe('Invalid API key')
    // The key is corrected: the very next call must reach the origin again, not replay the error.
    body = JSON.stringify({ errors: [], response: [rawFixture()] })
    const retried = await service.getFixtures('2026-09-28', 'good')
    expect(retried.error).toBeNull()
    expect(retried.fixtures).toHaveLength(1)
  })

  it('turns an HTTP error into a message rather than a throw', async () => {
    const origin = await startOrigin(() => ({ status: 500, body: 'boom' }))
    const service = createSportsFixturesService({ origin })
    const result = await service.getFixtures('2026-09-28', 'k')
    expect(result.fixtures).toHaveLength(0)
    expect(result.error).toMatch(/500/)
  })
})

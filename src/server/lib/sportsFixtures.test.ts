import { describe, it, expect, afterEach } from 'vitest'
import { createServer, type Server } from 'http'
import type { AddressInfo } from 'net'
import {
  createSportsFixturesService,
  describeInBandError,
  fixturesUrl,
  normalizeFixture,
  parseFixturesResponse
} from './sportsFixtures.js'

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

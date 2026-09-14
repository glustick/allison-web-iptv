import { describe, it, expect } from 'vitest'
import { buildGuideIndexes, channelTokens, matchStreamToGuideChannel, matchStreamToGuideChannelDetailed, normalizeChannelName, normalizeName } from './epgMatching.js'
import { parseXmltv } from './xmltv.js'

const NOW = Date.parse('2026-01-15T12:00:00Z')
const HOUR = 3_600_000

function guideFrom(channels: Array<{ id: string; displayName: string }>): ReturnType<typeof buildGuideIndexes> {
  const channelXml = channels
    .map((c) => `<channel id="${c.id}"><display-name>${c.displayName}</display-name></channel>`)
    .join('')
  const programmeXml = channels
    .map((c) => `<programme channel="${c.id}" start="20260115130000 +0000" stop="20260115140000 +0000"><title>On ${c.id}</title></programme>`)
    .join('')
  return buildGuideIndexes(parseXmltv(`<?xml version="1.0"?><tv>${channelXml}${programmeXml}</tv>`, { now: NOW }))
}

describe('normalizeName / normalizeChannelName', () => {
  it('lowercases, de-accentes, and collapses everything else to spaces', () => {
    expect(normalizeName('BBC One  HD')).toBe('bbc one hd')
    expect(normalizeName('Café+ Français')).toBe('cafe francais')
    expect(normalizeName('  Multiple   spaces  ')).toBe('multiple spaces')
  })

  it('strips leading country/region prefixes and trailing quality markers for channel matching', () => {
    expect(normalizeChannelName('US: ESPN News')).toBe(normalizeChannelName('ESPN News'))
    expect(normalizeChannelName('UK | BBC One')).toBe('bbc one')
    expect(normalizeChannelName('BBC One HD')).toBe('bbc one')
    expect(normalizeChannelName('Sportsnet World FHD')).toBe('sportsnet world')
  })

  it('keeps parenthesized qualifiers — they distinguish sibling feeds', () => {
    expect(normalizeChannelName('Big Brother Live Feeds (Camera 1)')).not.toBe(normalizeChannelName('Big Brother Live Feeds (Camera 2)'))
  })
})

describe('matchStreamToGuideChannel', () => {
  it('matches by exact epg_channel_id first', () => {
    const indexes = guideFrom([{ id: 'exact-id', displayName: 'Whatever' }])
    expect(matchStreamToGuideChannel({ stream_id: 1, name: 'Totally different', epg_channel_id: 'exact-id' }, indexes)).toBe('exact-id')
  })

  it('matches an epg_channel_id that differs only by formatting via normalization', () => {
    const indexes = guideFrom([{ id: 'UK-BBC.One_01', displayName: 'BBC One' }])
    expect(
      matchStreamToGuideChannel({ stream_id: 1, name: 'Unrelated name', epg_channel_id: 'uk bbc one 01' }, indexes)
    ).toBe('UK-BBC.One_01')
  })

  it('matches a stream with no usable id by normalized display-name', () => {
    const indexes = guideFrom([{ id: 'c1', displayName: 'BBC One HD' }])
    expect(matchStreamToGuideChannel({ stream_id: 1, name: 'UK: BBC One', epg_channel_id: null }, indexes)).toBe('c1')
  })

  it('refuses a name match when the normalized display-name is ambiguous between channels', () => {
    const indexes = guideFrom([
      { id: 'c1', displayName: 'BBC One HD' },
      { id: 'c2', displayName: 'US: BBC ONE' }
    ])
    expect(matchStreamToGuideChannel({ stream_id: 1, name: 'BBC One', epg_channel_id: null }, indexes)).toBeNull()
  })

  it('returns null when nothing matches', () => {
    const indexes = guideFrom([{ id: 'c1', displayName: 'BBC One' }])
    expect(matchStreamToGuideChannel({ stream_id: 1, name: 'Sky Sports', epg_channel_id: 'nope' }, indexes)).toBeNull()
  })

  it('ignores guide channels that have no programmes at all', () => {
    // buildGuideIndexes only indexes channels the guide actually has programmes for — a
    // display-name collision against a programme-less channel must not block or hijack a match.
    const withProgrammeless = parseXmltv(
      `<?xml version="1.0"?><tv>` +
        `<channel id="c1"><display-name>BBC One</display-name></channel>` +
        `<channel id="c2"><display-name>BBC One Backup</display-name></channel>` +
        `<programme channel="c1" start="20260115130000 +0000" stop="20260115140000 +0000"><title>On c1</title></programme>` +
        `</tv>`,
      { now: NOW }
    )
    const indexes = buildGuideIndexes(withProgrammeless)
    expect(matchStreamToGuideChannel({ stream_id: 1, name: 'BBC One', epg_channel_id: null }, indexes)).toBe('c1')
  })
})

describe('fuzzy name matching (v0.6.6)', () => {
  it('folds number words and quality/package noise into one token set', () => {
    expect(channelTokens('Sky Sports 1 HD')).toEqual(channelTokens('Sky Sports One'))
    expect(channelTokens('Discovery Channel HD')).toEqual(['discovery'])
    expect(channelTokens('MTV Hits TV')).toEqual(['mtv', 'hits'])
  })

  it('matches a stream whose name differs from the guide only by number words or packaging', () => {
    const indexes = guideFrom([{ id: 'g1', displayName: 'Sky Sports One HD' }])
    const match = matchStreamToGuideChannelDetailed({ stream_id: 1, name: 'Sky Sports 1', epg_channel_id: null }, indexes)
    expect(match).toMatchObject({ channelId: 'g1', strategy: 'fuzzy-name' })
    expect(match.score).toBeGreaterThanOrEqual(0.82)
  })

  it('still resolves pure quality-marker differences as an exact name match, not fuzzy', () => {
    const indexes = guideFrom([{ id: 'g1', displayName: 'Sky News' }])
    expect(matchStreamToGuideChannelDetailed({ stream_id: 1, name: 'Sky News HD', epg_channel_id: null }, indexes)).toMatchObject({
      channelId: 'g1',
      strategy: 'exact-name'
    })
  })

  it('recovers a regional suffix difference', () => {
    const indexes = guideFrom([{ id: 'g1', displayName: 'BBC One London' }])
    expect(matchStreamToGuideChannel({ stream_id: 1, name: 'BBC ONE Lon', epg_channel_id: null }, indexes)).toBe('g1')
  })

  it('refuses an ambiguous fuzzy match rather than guessing between siblings', () => {
    const indexes = guideFrom([
      { id: 'g1', displayName: 'Sky Sports 1' },
      { id: 'g2', displayName: 'Sky Sports 2' }
    ])
    expect(matchStreamToGuideChannel({ stream_id: 1, name: 'Sky Sports', epg_channel_id: null }, indexes)).toBeNull()
  })

  it('never fuzzes two genuinely different channels together', () => {
    const indexes = guideFrom([
      { id: 'g1', displayName: 'BBC One' },
      { id: 'g2', displayName: 'BBC Two' }
    ])
    expect(matchStreamToGuideChannel({ stream_id: 1, name: 'ITV1', epg_channel_id: null }, indexes)).toBeNull()
  })

  it('keeps exact epg_channel_id matches ahead of any fuzzy candidate', () => {
    const indexes = guideFrom([
      { id: 'exact-id', displayName: 'Something Else Entirely' },
      { id: 'g2', displayName: 'Sky News' }
    ])
    expect(matchStreamToGuideChannelDetailed({ stream_id: 1, name: 'Sky News HD', epg_channel_id: 'exact-id' }, indexes)).toMatchObject({
      channelId: 'exact-id',
      strategy: 'exact-id'
    })
  })

  it('stays fast across thousands of channels (3,200 streams vs a 6,000-channel guide)', () => {
    const channels: Array<{ id: string; displayName: string }> = []
    for (let i = 0; i < 6000; i++) channels.push({ id: `c${i}`, displayName: `Network ${i} Channel HD` })
    // A realistic subset of guide names that differ from the stream names being matched below.
    channels[100] = { id: 'c100', displayName: 'Sky Sports One HD' }
    channels[101] = { id: 'c101', displayName: 'BBC One London' }
    const indexes = guideFrom(channels)

    const streams = Array.from({ length: 3200 }, (_, i) => ({
      stream_id: i,
      // Deliberately mostly non-matching names, so the fuzzy scorer does real work.
      name: `US: Some Provider Feed ${i}`,
      epg_channel_id: null
    }))
    streams[0] = { stream_id: 0, name: 'Sky Sports 1', epg_channel_id: null }
    streams[1] = { stream_id: 1, name: 'BBC ONE Lon', epg_channel_id: null }

    const startedAt = Date.now()
    const matched = streams.map((stream) => matchStreamToGuideChannel(stream, indexes))
    const elapsed = Date.now() - startedAt

    expect(matched[0]).toBe('c100')
    expect(matched[1]).toBe('c101')
    // The index makes this a bounded candidate scan per stream; anything near a full
    // cross-product (19M comparisons) would take orders of magnitude longer.
    expect(elapsed).toBeLessThan(2000)
  })
})

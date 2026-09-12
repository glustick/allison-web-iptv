import { describe, it, expect } from 'vitest'
import { buildGuideIndexes, matchStreamToGuideChannel, normalizeChannelName, normalizeName } from './epgMatching.js'
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

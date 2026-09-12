import { describe, it, expect } from 'vitest'
import { parseXmltv, parseXmltvDate } from './xmltv.js'

function xmltvDate(ms: number, offset = '+0000'): string {
  const d = new Date(ms)
  const pad = (n: number, width = 2): string => String(n).padStart(width, '0')
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())} ${offset}`
  )
}

const HOUR = 3_600_000

describe('parseXmltvDate', () => {
  it('parses the canonical `YYYYMMDDHHmmss +ZZZZ` shape', () => {
    expect(parseXmltvDate('20240101120000 +0000')).toBe(Date.parse('2024-01-01T12:00:00Z'))
  })

  it('applies a non-UTC offset correctly', () => {
    expect(parseXmltvDate('20240101120000 +0200')).toBe(Date.parse('2024-01-01T10:00:00Z'))
    expect(parseXmltvDate('20240101120000 -0530')).toBe(Date.parse('2024-01-01T17:30:00Z'))
  })

  it('treats a missing offset as UTC', () => {
    expect(parseXmltvDate('20240101120000')).toBe(Date.parse('2024-01-01T12:00:00Z'))
  })

  it('falls back to Date.parse for other shapes, NaN for garbage', () => {
    expect(parseXmltvDate('2024-01-01T12:00:00Z')).toBe(Date.parse('2024-01-01T12:00:00Z'))
    expect(Number.isNaN(parseXmltvDate('not a date'))).toBe(true)
  })
})

describe('parseXmltv', () => {
  const now = Date.parse('2026-01-15T12:00:00Z')

  function build(fixture: { channelId: string; displayName: string; programmes: Array<{ startMs: number; stopMs: number; title: string; desc?: string }> }): string {
    const programmes = fixture.programmes
      .map((p) => `<programme channel="${fixture.channelId}" start="${xmltvDate(p.startMs)}" stop="${xmltvDate(p.stopMs)}"><title>${p.title}</title>${p.desc ? `<desc>${p.desc}</desc>` : ''}</programme>`)
      .join('')
    return `<?xml version="1.0"?><tv><channel id="${fixture.channelId}"><display-name>${fixture.displayName}</display-name></channel>${programmes}</tv>`
  }

  it('indexes channels and programmes by the guide channel id, sorted by start', () => {
    const guide = parseXmltv(
      build({ channelId: 'c1', displayName: 'Channel One', programmes: [
        { startMs: now + HOUR, stopMs: now + 2 * HOUR, title: 'Later' },
        { startMs: now - HOUR, stopMs: now, title: 'Earlier' }
      ] }),
      { now }
    )
    expect(guide.channels.get('c1')?.displayName).toBe('Channel One')
    const programmes = guide.programmesByChannel.get('c1') ?? []
    expect(programmes.map((p) => p.title)).toEqual(['Earlier', 'Later'])
    expect(programmes[0].startMs).toBe(now - HOUR)
    expect(programmes[0].stopMs).toBe(now)
  })

  it('drops programmes with unparseable dates instead of keeping NaN entries', () => {
    const xml =
      `<?xml version="1.0"?><tv>` +
      `<channel id="c1"><display-name>Channel One</display-name></channel>` +
      `<programme channel="c1" start="garbage" stop="${xmltvDate(now + HOUR)}"><title>Bad start</title></programme>` +
      `<programme channel="c1" start="${xmltvDate(now + HOUR)}" stop="${xmltvDate(now + 2 * HOUR)}"><title>Good</title></programme>` +
      `</tv>`
    const guide = parseXmltv(xml, { now })
    expect((guide.programmesByChannel.get('c1') ?? []).map((p) => p.title)).toEqual(['Good'])
  })

  it('prunes programmes outside the rolling 24h-back/72h-forward window at ingest', () => {
    const xml = build({ channelId: 'c1', displayName: 'Channel One', programmes: [
      { startMs: now - 30 * HOUR, stopMs: now - 25 * HOUR, title: 'Ancient history' },
      { startMs: now - 2 * HOUR, stopMs: now - HOUR, title: 'Recent past' },
      { startMs: now + HOUR, stopMs: now + 2 * HOUR, title: 'Soon' },
      { startMs: now + 80 * HOUR, stopMs: now + 81 * HOUR, title: 'Far future' }
    ] })
    const guide = parseXmltv(xml, { now })
    expect((guide.programmesByChannel.get('c1') ?? []).map((p) => p.title)).toEqual(['Recent past', 'Soon'])
  })

  it('handles #text-wrapped title/desc elements some generators emit', () => {
    const xml =
      `<?xml version="1.0"?><tv>` +
      `<channel id="c1"><display-name>Channel One</display-name></channel>` +
      `<programme channel="c1" start="${xmltvDate(now + HOUR)}" stop="${xmltvDate(now + 2 * HOUR)}">` +
      `<title lang="en"><![CDATA[Wrapped title]]></title><desc lang="en">Wrapped desc</desc>` +
      `</programme></tv>`
    const guide = parseXmltv(xml, { now })
    const programme = (guide.programmesByChannel.get('c1') ?? [])[0]
    expect(programme.title).toBe('Wrapped title')
    expect(programme.description).toBe('Wrapped desc')
  })
})

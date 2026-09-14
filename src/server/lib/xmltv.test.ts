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

  it('parses a guide whose <desc> carries raw, deeply nested HTML markup (no CDATA)', () => {
    // Reproduced from a real external guide: 140 levels of <div> inside one description blew
    // fast-xml-parser's nesting guard ("Maximum nested tags exceeded") and failed the whole
    // source. Free-text desc content is kept raw, so depth no longer matters.
    const deepHtml = `${'<div>'.repeat(140)}Pay per view boxing this Saturday${'</div>'.repeat(140)}`
    const xml =
      `<?xml version="1.0"?><tv>` +
      `<channel id="c1"><display-name>Sky Sports Box Office</display-name></channel>` +
      `<programme channel="c1" start="${xmltvDate(now + HOUR)}" stop="${xmltvDate(now + 2 * HOUR)}">` +
      `<title>Fight Night</title><desc>${deepHtml}</desc></programme></tv>`

    const guide = parseXmltv(xml, { now })
    expect(guide.channels.get('c1')?.displayName).toBe('Sky Sports Box Office')
    const programme = (guide.programmesByChannel.get('c1') ?? [])[0]
    expect(programme.title).toBe('Fight Night')
    expect(programme.description).toContain('Pay per view boxing')
    expect(programme.description).not.toContain('<')
  })

  it('strips markup out of titles and display names', () => {
    const xml =
      `<?xml version="1.0"?><tv>` +
      `<channel id="c1"><display-name>Sky Sports <b>One</b></display-name></channel>` +
      `<programme channel="c1" start="${xmltvDate(now + HOUR)}" stop="${xmltvDate(now + 2 * HOUR)}">` +
      `<title>Fight <i>Night</i></title></programme></tv>`

    const guide = parseXmltv(xml, { now })
    expect(guide.channels.get('c1')?.displayName).toBe('Sky Sports One')
    expect((guide.programmesByChannel.get('c1') ?? [])[0].title).toBe('Fight Night')
  })

  it('caps very long descriptions so a grid window stays small', () => {
    const huge = 'x'.repeat(5000)
    const xml =
      `<?xml version="1.0"?><tv>` +
      `<channel id="c1"><display-name>Channel One</display-name></channel>` +
      `<programme channel="c1" start="${xmltvDate(now + HOUR)}" stop="${xmltvDate(now + 2 * HOUR)}">` +
      `<title>T</title><desc>${huge}</desc></programme></tv>`

    const guide = parseXmltv(xml, { now })
    const description = (guide.programmesByChannel.get('c1') ?? [])[0].description ?? ''
    expect(description.length).toBeLessThanOrEqual(600)
  })

  it('tolerates deep markup that is NOT under the usual tv.programme leaves', () => {
    // The shape that still failed after the first fix: the stop-node list named exact paths, so
    // deep nesting elsewhere (a wrapper element, a differently shaped document region) tripped
    // the nesting guard anyway. Leaf-name matching plus the raised ceiling covers it.
    const deep = `${'<x>'.repeat(600)}junk${'</x>'.repeat(600)}`
    const xml =
      `<?xml version="1.0"?><tv>` +
      `<channel id="c1"><display-name>Channel One</display-name></channel>` +
      `<wrapper>${deep}</wrapper>` +
      `<programme channel="c1" start="${xmltvDate(now + HOUR)}" stop="${xmltvDate(now + 2 * HOUR)}"><title>Still Parses</title></programme></tv>`

    const guide = parseXmltv(xml, { now })
    expect(guide.channels.get('c1')?.displayName).toBe('Channel One')
    expect((guide.programmesByChannel.get('c1') ?? [])[0].title).toBe('Still Parses')
  })

  it('reports a document that is not an XMLTV guide instead of pretending it is empty', () => {
    expect(() => parseXmltv('<html><body>Not a guide</body></html>', { now })).toThrow(/not an xmltv guide/i)
  })

  it('refuses absurdly nested input with a message naming the limit', () => {
    const absurd = `${'<x>'.repeat(10_100)}deep${'</x>'.repeat(10_100)}`
    expect(() => parseXmltv(`<?xml version="1.0"?><tv>${absurd}</tv>`, { now })).toThrow(/nests more than/i)
  })
})

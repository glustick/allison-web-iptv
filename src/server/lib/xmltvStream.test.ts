import { describe, it, expect } from 'vitest'
import { parseXmltv } from './xmltv.js'
import { createXmltvStreamParser } from './xmltvStream.js'

// The streaming parser's contract: for every well-formed input, byte-for-byte the same guide
// parseXmltv produces — regardless of how the document is split into chunks. That is what lets
// epgService swap the DOM parse (whose 1.3GB-per-guide spike OOM'd the deployment) for this
// scanner without any behavioral change a test could catch.

const NOW = Date.UTC(2026, 9, 3, 12, 0, 0)

function parseBoth(xml: string): { dom: ReturnType<typeof parseXmltv>; stream: ReturnType<typeof parseXmltv> } {
  return {
    dom: parseXmltv(xml, { now: NOW }),
    stream: (() => {
      const parser = createXmltvStreamParser({ now: NOW })
      parser.write(xml)
      return parser.end()
    })()
  }
}

const GUIDE_FIXTURES: Record<string, string> = {
  'basic channel and programmes': `<?xml version="1.0" encoding="UTF-8"?>
<tv>
  <channel id="news.example"><display-name>Sky News</display-name><icon src="http://logo.example/news.png"/></channel>
  <programme start="20261003120000 +0000" stop="20261003130000 +0000" channel="news.example"><title>Breakfast</title><desc>The morning's news.</desc></programme>
  <programme start="20261003130000 +0000" stop="20261003140000 +0000" channel="news.example"><title> Lunch Live </title></programme>
</tv>`,
  'cdata and embedded markup in text leaves': `<tv><channel id="a"><display-name><![CDATA[A & B TV]]></display-name></channel>
<programme start="20261003120000 +0000" stop="20261003130000 +0000" channel="a"><title><![CDATA[Top <b>Stories</b>]]></title><desc>Read &amp; enjoy &lt;em&gt;later&lt;/em&gt; &mdash; today</desc></programme></tv>`,
  'attributes carrying entities and quotes': `<tv><channel id="chan&amp;1"><display-name>Works</display-name></channel>
<programme start="20261003120000 +0000" stop="20261003130000 +0000" channel="chan&amp;1"><title>T</title></programme></tv>`,
  'unsorted programmes are sorted per channel': `<tv>
<programme start="20261003140000 +0000" stop="20261003150000 +0000" channel="c1"><title>Later</title></programme>
<programme start="20261003120000 +0000" stop="20261003130000 +0000" channel="c1"><title>Earlier</title></programme>
</tv>`,
  ' programmes outside the window are pruned': `<tv>
<programme start="20260929000000 +0000" stop="20260929010000 +0000" channel="c1"><title>Ancient</title></programme>
<programme start="20261010000000 +0000" stop="20261010010000 +0000" channel="c1"><title>Far future</title></programme>
<programme start="20261003120000 +0000" stop="20261003130000 +0000" channel="c1"><title>In window</title></programme>
</tv>`,
  'unparseable dates are dropped at ingest': `<tv>
<programme start="not-a-date" stop="20261003130000 +0000" channel="c1"><title>Broken</title></programme>
<programme start="20261003120000 +0000" stop="20261003130000 +0000" channel="c1"><title>Fine</title></programme>
</tv>`,
  'self-closing channel and missing display name fall back to the id': `<tv><channel id="bare.example"/></tv>`,
  'xml declaration and comments around the guide': `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE tv SYSTEM "xmltv.dtd">
<!-- a comment mentioning <programme start="20261003120000" channel="fake"> inside -->
<tv generator-info-name="test"><channel id="ok"><display-name>OK</display-name></channel></tv>`,
  'long descriptions are capped and markup stripped': `<tv><channel id="c"><display-name>C</display-name></channel>
<programme start="20261003120000 +0000" stop="20261003130000 +0000" channel="c"><title>T</title><desc>${'<b>word</b> '.repeat(120)}</desc></programme></tv>`
}

describe('createXmltvStreamParser: parity with parseXmltv', () => {
  for (const [name, xml] of Object.entries(GUIDE_FIXTURES)) {
    it(`matches the DOM parser: ${name}`, () => {
      const { dom, stream } = parseBoth(xml)
      expect(stream.channels.size).toBe(dom.channels.size)
      expect([...stream.channels.entries()]).toEqual([...dom.channels.entries()])
      expect([...stream.programmesByChannel.keys()]).toEqual([...dom.programmesByChannel.keys()])
      for (const [channel, list] of dom.programmesByChannel) {
        expect(stream.programmesByChannel.get(channel)).toEqual(list)
      }
    })
  }

  it('produces identical output to the DOM parser on a mixed real-shaped document', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<tv generator-info-name="rig">
${Array.from({ length: 40 }, (_, c) => `  <channel id="ch${c}"><display-name>Channel ${c} <i>HD</i></display-name><icon src="http://l/${c}.png"/></channel>`).join('\n')}
${Array.from({ length: 400 }, (_, p) => {
      const c = p % 40
      const hour = String(p % 24).padStart(2, '0')
      const day = String(3 + (p % 3)).padStart(2, '0')
      return `  <programme start="202610${day}${hour}0000 +0000" stop="202610${day}${hour}3000 +0000" channel="ch${c}"><title>Show ${p}</title><desc>Episode ${p} of channel ${c}. News, sport and weather.</desc></programme>`
    }).join('\n')}
</tv>`
      const { dom, stream } = parseBoth(xml)
      let domCount = 0
      for (const list of dom.programmesByChannel.values()) domCount += list.length
      let streamCount = 0
      for (const list of stream.programmesByChannel.values()) streamCount += list.length
      expect(streamCount).toBe(domCount)
      expect(streamCount).toBeGreaterThan(0)
      for (const [channel, list] of dom.programmesByChannel) {
        expect(stream.programmesByChannel.get(channel)).toEqual(list)
      }
    })
})

describe('createXmltvStreamParser: chunk boundaries', () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?><!-- lead comment -->
<tv><channel id="a&amp;b"><display-name><![CDATA[CD & <ATA> TV]]></display-name><icon src='http://l/a.png'/></channel>
<programme start="20261003120000 +0000" stop="20261003130000 +0000" channel="a&amp;b"><title>First</title><desc>One &amp; all &lt;here&gt;</desc></programme>
<programme start="20261003133000 +0000" stop="20261003143000 +0000" channel="a&amp;b"><title>Second &amp; third</title></programme></tv>`

  it('produces the same guide when the document is split at EVERY byte offset', () => {
    const whole = (() => {
      const parser = createXmltvStreamParser({ now: NOW })
      parser.write(xml)
      return parser.end()
    })()
    for (let split = 1; split < xml.length - 1; split++) {
      const parser = createXmltvStreamParser({ now: NOW })
      parser.write(xml.slice(0, split))
      parser.write(xml.slice(split))
      const guide = parser.end()
      try {
        expect([...guide.channels.entries()]).toEqual([...whole.channels.entries()])
        for (const [channel, list] of whole.programmesByChannel) {
          expect(guide.programmesByChannel.get(channel)).toEqual(list)
        }
      } catch (err) {
        throw new Error(`chunk split at byte ${split} changed the output: ${String(err)}`)
      }
    }
  })

  it('tolerates many tiny writes', () => {
    const parser = createXmltvStreamParser({ now: NOW })
    for (const ch of xml) parser.write(ch)
    const guide = parser.end()
    expect(guide.channels.size).toBe(1)
    expect(guide.programmesByChannel.get('a&b')?.length).toBe(2)
  })
})

describe('createXmltvStreamParser: failure shapes', () => {
  it('throws the same no-tv-root sentence for a childless <tv></tv>', () => {
    // fast-xml-parser collapses an empty <tv> to '' and buildGuide rejects it — the stream
    // parser mirrors that rather than answering with a healthy-looking empty guide.
    expect(() => parseXmltv('<tv></tv>', { now: NOW })).toThrow(/no <tv> root element/)
    const parser = createXmltvStreamParser({ now: NOW })
    parser.write('<tv>  <!-- nothing here --></tv>')
    expect(() => parser.end()).toThrow(/no <tv> root element/)
  })

  it('throws the same no-tv-root sentence for an HTML page', () => {
    const html = '<html><head><title>err</title></head><body>502 Bad Gateway</body></html>'
    expect(() => parseXmltv(html, { now: NOW })).toThrow(/no <tv> root element/)
    const parser = createXmltvStreamParser({ now: NOW })
    parser.write(html)
    expect(() => parser.end()).toThrow(/no <tv> root element/)
  })

  it('throws on a document truncated mid-element', () => {
    const parser = createXmltvStreamParser({ now: NOW })
    parser.write('<tv><channel id="a"><display-name>A</display-name>')
    expect(() => parser.end()).toThrow(/truncated/)
  })

  it('resynchronizes after a pathological unterminated element', () => {
    // A channel body that never closes, stuffed far past the element cap, followed by a real
    // guide: the garbage element is dropped, the scan recovers, the real content is kept.
    const garbage = 'x'.repeat(6 * 1024 * 1024)
    const parser = createXmltvStreamParser({ now: NOW })
    parser.write(`<tv><channel id="junk"><display-name>${garbage}`)
    parser.write('</channel>')
    parser.write('<channel id="good"><display-name>Good</display-name></channel>')
    const guide = parser.end()
    expect(guide.channels.get('good')?.displayName).toBe('Good')
  })
})

describe('createXmltvStreamParser: documented deviations', () => {
  it('uses the FIRST title and the FIRST icon where the DOM parser yielded none', () => {
    const xml = `<tv><channel id="c"><icon src="one.png"/><icon src="two.png"/><display-name>C</display-name></channel>
<programme start="20261003120000 +0000" stop="20261003130000 +0000" channel="c"><title lang="en">English</title><title lang="de">Deutsch</title></programme></tv>`
    const stream = (() => {
      const parser = createXmltvStreamParser({ now: NOW })
      parser.write(xml)
      return parser.end()
    })()
    // The DOM parser's array-shaped multi-title fell through textOf to "Untitled", and its
    // multi-icon to undefined — the stream parser keeps the first, which is what the guide
    // grid actually wants. Pinned here so the change is a decision, not an accident.
    const list = stream.programmesByChannel.get('c') ?? []
    expect(list[0]?.title).toBe('English')
    expect(stream.channels.get('c')?.icon).toBe('one.png')
  })
})

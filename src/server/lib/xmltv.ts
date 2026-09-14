import { XMLParser } from 'fast-xml-parser'

// Server-side XMLTV parser for epgService.ts — a sibling of the client's own lib/epg.ts (same
// fast-xml-parser options, same XMLTV date handling), deliberately a separate copy rather than a
// shared module: the client and server are separate TypeScript projects with separate tsconfig
// roots, and this port matches this repo's existing convention of porting-and-adapting the
// desktop app's per-side files (see proxyServer.ts vs the client's player code). Differences
// from the client copy are intentional: programme start/stop are epoch milliseconds (the wire
// format /api/epg serves), and programmes with unparseable dates are dropped here rather than
// kept as Invalid Dates — an aggregated guide fed from arbitrary user-supplied sources can't
// afford NaN-positioned blocks silently poisoning the grid.

export interface XmltvChannel {
  id: string
  displayName: string
  icon?: string
}

export interface XmltvProgramme {
  channelId: string
  startMs: number
  stopMs: number
  title: string
  description?: string
}

export interface XmltvGuide {
  channels: Map<string, XmltvChannel>
  programmesByChannel: Map<string, XmltvProgramme[]>
}

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return []
  return Array.isArray(value) ? value : [value]
}

const MAX_TITLE_CHARS = 200
const MAX_DESCRIPTION_CHARS = 600

/**
 * Guide text as displayable plain text. Providers put raw markup inside these fields (an
 * unCDATA'd `<b>` in a title, or a whole HTML blurb in a description), so markup is stripped
 * and whitespace collapsed, and the result is capped — a 3-hour grid window shouldn't ship
 * hundreds of kilobytes of someone's HTML.
 */
function cleanText(raw: string, limit: number): string {
  const stripped = raw
    // CDATA wrappers first (raw stop-node content is not unwrapped by the parser), then tags.
    .replace(/<!\[CDATA\[/g, ' ')
    .replace(/\]\]>/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
  return stripped.length > limit ? `${stripped.slice(0, limit - 1)}…` : stripped
}

function textOf(value: unknown, limit = MAX_TITLE_CHARS): string | undefined {
  if (value == null) return undefined
  if (typeof value === 'string') {
    const cleaned = cleanText(value, limit)
    return cleaned.length > 0 ? cleaned : undefined
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    if ('#text' in record) return textOf(record['#text'], limit)
    // A stop-node-free object (markup without CDATA at shallow depth) — walk it for text.
    return undefined
  }
  return String(value)
}

/** XMLTV timestamps look like `20240101120000 +0000`. Returns NaN when unparseable. */
export function parseXmltvDateMs(value: string): number {
  const direct = Date.parse(value)
  if (!Number.isNaN(direct)) return direct
  return Number.NaN
}

export function parseXmltvDate(value: string): number {
  const match = value.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\s*([+-]\d{4})?$/)
  if (!match) return parseXmltvDateMs(value)
  const [, year, month, day, hour, minute, second, offset] = match
  const normalizedOffset = offset ? `${offset.slice(0, 3)}:${offset.slice(3)}` : 'Z'
  return Date.parse(`${year}-${month}-${day}T${hour}:${minute}:${second}${normalizedOffset}`)
}

// Aggregated guides are pruned to a rolling window at ingest: the EPG grid is a now-oriented
// surface (catch-up/timeshift playback doesn't exist yet — see ROADMAP), and a full provider
// guide is ~98MB of XML whose parsed form would otherwise sit in server memory by the hundreds
// of megabytes on a NAS. 24h back / 72h forward comfortably covers grid navigation while
// typically discarding most of the payload.
const PRUNE_PAST_MS = 24 * 3_600_000
const PRUNE_FUTURE_MS = 72 * 3_600_000

// A guide's free-text leaves are kept raw rather than parsed: external sources routinely embed
// raw, unCDATA'd HTML there, which is what produced "Maximum nested tags exceeded" on real
// guides (140 levels of <div> inside one description failed an entire source — reproduced live).
// Keeping them raw also avoids building a deep object tree per programme, which on a
// 300k-programme guide is the difference between hundreds of MB of garbage and none.
//
// Matched by leaf name (*.) rather than exact tv.programme.desc paths: a real source still
// failed after the first fix because its markup did not sit under the exact paths that list
// named, so the guard fired anyway. Leaf matching covers unknown document shapes.
const MAX_NESTED_TAGS = 10_000
const PARSER_OPTIONS = {
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  stopNodes: ['*.display-name', '*.title', '*.sub-title', '*.desc', '*.category'],
  // fast-xml-parser defaults this to 100, which real guides exceed. Raised far past anything
  // markuppy content produces at depth, but kept finite: this parser's job is a TV guide, and a
  // document nesting thousands deep is malformed input worth refusing with a clear message.
  maxNestedTags: MAX_NESTED_TAGS
}

export function parseXmltv(xml: string, opts?: { now?: number }): XmltvGuide {
  const now = opts?.now ?? Date.now()
  const parsed = parseDocument(xml)
  return buildGuide(parsed, now)
}

/** Parses the XML, turning the parser's nesting guard into a self-describing error. */
function parseDocument(xml: string): { tv?: { channel?: unknown; programme?: unknown } } {
  const parser = new XMLParser(PARSER_OPTIONS)
  try {
    return parser.parse(xml) as { tv?: { channel?: unknown; programme?: unknown } }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (/nested tags/i.test(message)) {
      throw new Error(
        `Guide XML nests more than ${MAX_NESTED_TAGS} levels — this source is malformed or is not an XMLTV guide`
      )
    }
    throw err instanceof Error ? err : new Error(message)
  }
}

function buildGuide(doc: { tv?: { channel?: unknown; programme?: unknown } }, now: number): XmltvGuide {
  if (!doc.tv || typeof doc.tv !== 'object') {
    // A source that parses as XML but has no <tv> root isn't an XMLTV guide (an HTML page, a
    // JSON payload, an error document). Saying so beats reporting a healthy source with zero
    // channels, which is what an "ok, 0 guide channels" row would have implied.
    throw new Error('Not an XMLTV guide: no <tv> root element found in the response')
  }
  const tv = doc.tv

  const channels = new Map<string, XmltvChannel>()
  for (const raw of asArray(tv.channel as any)) {
    const id = String(raw['@_id'])
    const displayName = textOf(raw['display-name']) ?? id
    const icon = raw.icon?.['@_src']
    channels.set(id, { id, displayName, icon })
  }

  const programmesByChannel = new Map<string, XmltvProgramme[]>()
  for (const raw of asArray(tv.programme as any)) {
    const channelId = String(raw['@_channel'])
    const startMs = parseXmltvDate(String(raw['@_start']))
    const stopMs = parseXmltvDate(String(raw['@_stop']))
    // Drop programmes without usable times (or outside the rolling window — see PRUNE_*
    // above) at ingest so they can never reach the grid.
    if (!Number.isFinite(startMs) || !Number.isFinite(stopMs)) continue
    if (stopMs < now - PRUNE_PAST_MS || startMs > now + PRUNE_FUTURE_MS) continue
    const programme: XmltvProgramme = {
      channelId,
      startMs,
      stopMs,
      title: textOf(raw.title) ?? 'Untitled',
      description: textOf(raw.desc, MAX_DESCRIPTION_CHARS)
    }
    const list = programmesByChannel.get(channelId)
    if (list) {
      list.push(programme)
    } else {
      programmesByChannel.set(channelId, [programme])
    }
  }

  for (const list of programmesByChannel.values()) {
    list.sort((a, b) => a.startMs - b.startMs)
  }

  return { channels, programmesByChannel }
}

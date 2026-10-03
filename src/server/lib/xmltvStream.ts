import { cleanText, parseXmltvDate, PRUNE_FUTURE_MS, PRUNE_PAST_MS, type XmltvChannel, type XmltvGuide, type XmltvProgramme } from './xmltv.js'

// A streaming XMLTV parser: the same output as xmltv.ts's parseXmltv, without ever building a
// DOM of the document.
//
// Why this exists is a number: fast-xml-parser builds the whole document tree, and the
// deployment's guide set grew to ~400MB of XML across three sources — measured on this repo's
// own rig, parsing one 195MB guide costs ~1.3GB of heap that is thrown away the moment the slim
// XmltvGuide is built (which itself is small, because buildGuide prunes to a 24h-back/72h-forward
// window at ingest). On the NAS that crossed V8's heap limit: every restart, the first guide
// request re-hydrated from the disk cache, the parse OOM'd, and the container crash-looped.
// The parse spike is the entire problem, so this parser scans the document incrementally and
// keeps only what buildGuide would keep. Peak cost is now a small constant buffer plus the
// retained (pruned) guide itself.
//
// Deliberately hand-rolled rather than a second library: XMLTV is machine-generated with a fixed
// element surface (channel/programme and a handful of text leaves), so the scanner only needs
// open tags with attributes, leaf text, comments, and CDATA — each piece unit-tested. Chunks can
// split anywhere, including mid-tag and mid-CDATA; the buffer holds at most one element.
//
// Documented deviations from the DOM parser (both strict improvements, both pinned by tests):
// multiple <title>/<desc>/<display-name> children now use the FIRST (the DOM parser's
// array-shaped value fell through textOf to undefined/"Untitled"), and the same for multiple
// <icon> elements. Everything else — attribute entity decoding, raw (undecoded) leaf text
// matching fast-xml-parser's stopNodes behavior, CDATA handling, date parsing, the prune
// window, the per-channel sort, the no-<tv>-root error — matches parseXmltv exactly.

const MAX_ELEMENT_BYTES = 4 * 1024 * 1024

/** Decodes the five XML predefined entities plus numeric character references — the set an
 *  attribute value can legally carry. (&amp; last, so it does not double-decode the rest.) */
export function decodeXmlAttribute(raw: string): string {
  let out = raw.replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
  out = out.replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
  return out
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

function attributeValue(openTag: string, name: string): string | undefined {
  const match = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`).exec(openTag)
  if (!match) return undefined
  const raw = match[2] ?? match[3] ?? ''
  return decodeXmlAttribute(raw)
}

/** The first `<leaf…>…</leaf>` inner text inside an element body, or undefined. */
function leafText(body: string, leaf: string): string | undefined {
  const open = new RegExp(`<${leaf}(\\s[^>]*)?>`).exec(body)
  if (!open) return undefined
  const start = open.index + open[0].length
  const close = body.indexOf(`</${leaf}>`, start)
  if (close === -1) return undefined
  return body.slice(start, close)
}

function firstIconSrc(body: string): string | undefined {
  const open = /<icon\b[^>]*>/.exec(body)
  if (!open) return undefined
  const src = attributeValue(open[0], 'src')
  return src === undefined ? undefined : src
}

export interface XmltvStreamParser {
  /** Feeds the next text chunk (already decoded from bytes by the caller). */
  write(chunk: string): void
  /** Finishes the document and returns the guide. Throws on a truncated element or a document
   *  with no <tv> root — the same failures parseXmltv throws for the same inputs. */
  end(): XmltvGuide
}

export function createXmltvStreamParser(opts?: { now?: number }): XmltvStreamParser {
  const now = opts?.now ?? Date.now()

  let buffer = ''
  let sawTv = false // any <tv> open tag, self-closing or not
  // fast-xml-parser collapses a childless <tv></tv> to an empty string, which buildGuide then
  // rejects with the no-tv-root error; mirror that (a <tv> with no channel/programme children
  // is the same failure, whatever the whitespace and comments around them).
  let sawElement = false
  // null = seeking the next <channel>/<programme>; otherwise the element being accumulated.
  let inside: 'channel' | 'programme' | null = null
  let openTag = ''
  let body = ''
  let overflowed = false

  const channels = new Map<string, XmltvChannel>()
  const programmesByChannel = new Map<string, XmltvProgramme[]>()

  function parseOpenTag(tag: string): void {
    const kind = /^<\s*(channel|programme)\b/.exec(tag)?.[1] as 'channel' | 'programme'
    sawElement = true
    if (kind === 'channel') {
      const id = attributeValue(tag, 'id') ?? String(undefined)
      const displayNameRaw = leafText(body, 'display-name')
      const displayName = displayNameRaw !== undefined ? cleanText(displayNameRaw, 200) || id : id
      const icon = firstIconSrc(body)
      channels.set(id, icon !== undefined ? { id, displayName, icon } : { id, displayName })
      return
    }
    // programme
    const channelId = attributeValue(tag, 'channel') ?? String(undefined)
    const startMs = parseXmltvDate(attributeValue(tag, 'start') ?? String(undefined))
    const stopMs = parseXmltvDate(attributeValue(tag, 'stop') ?? String(undefined))
    if (!Number.isFinite(startMs) || !Number.isFinite(stopMs)) return
    if (stopMs < now - PRUNE_PAST_MS || startMs > now + PRUNE_FUTURE_MS) return
    const titleRaw = leafText(body, 'title')
    const title = titleRaw !== undefined ? cleanText(titleRaw, 200) : undefined
    const descRaw = leafText(body, 'desc')
    const description = descRaw !== undefined ? cleanText(descRaw, 600) : undefined
    const programme: XmltvProgramme = {
      channelId,
      startMs,
      stopMs,
      title: title && title.length > 0 ? title : 'Untitled',
      description
    }
    const list = programmesByChannel.get(channelId)
    if (list) {
      list.push(programme)
    } else {
      programmesByChannel.set(channelId, [programme])
    }
  }

  /** Finds the next `<channel`, `<programme`, `<tv` or `<!--` from `from`. -1 when none (yet). */
  function nextTokenIndex(from: number): { index: number; kind: 'channel' | 'programme' | 'tv' | 'comment' } | -1 {
    const re = /<(channel|programme|tv)[\s/>]|<!--/g
    re.lastIndex = from
    const match = re.exec(buffer)
    if (!match) return -1
    return {
      index: match.index,
      kind: match[0] === '<!--' ? 'comment' : (match[1] as 'channel' | 'programme' | 'tv')
    }
  }

  /** The index of the `>` closing the open tag that starts at `start`, honoring quoted
   *  attribute values (a `>` inside quotes does not end the tag). -1 when not fully arrived. */
  function openTagEnd(start: number): number {
    let quote: string | null = null
    for (let i = start; i < buffer.length; i++) {
      const ch = buffer[i]
      if (quote) {
        if (ch === quote) quote = null
      } else if (ch === '"' || ch === "'") {
        quote = ch
      } else if (ch === '>') {
        return i
      }
    }
    return -1
  }

  function process(): void {
    let p = 0
    for (;;) {
      if (inside) {
        const closeTag = `</${inside}>`
        const close = buffer.indexOf(closeTag, p)
        if (close === -1) {
          // Consume the body — but hold back any trailing partial close tag ('</chan' mid-split
          // across writes would otherwise be eaten as body text and the real close, arriving
          // later, would never match). Everything that cannot be a closeTag prefix is body.
          const rest = buffer.slice(p)
          let keep = rest
          let tail = ''
          const max = Math.min(closeTag.length - 1, rest.length)
          for (let k = max; k > 0; k--) {
            if (rest.endsWith(closeTag.slice(0, k))) {
              keep = rest.slice(0, rest.length - k)
              tail = rest.slice(rest.length - k)
              break
            }
          }
          body += keep
          if (body.length > MAX_ELEMENT_BYTES) {
            // Pathological element (never legitimate XMLTV): drop its content but keep
            // scanning for the close tag so the parser can resynchronize.
            overflowed = true
            body = ''
          }
          buffer = tail
          p = 0
          return
        }
        body += buffer.slice(p, close)
        p = close + closeTag.length
        if (!overflowed) parseOpenTag(openTag)
        inside = null
        openTag = ''
        body = ''
        overflowed = false
        continue
      }
      const token = nextTokenIndex(p)
      if (token === -1) {
        buffer = buffer.slice(p)
        return
      }
      if (token.kind === 'comment') {
        const end = buffer.indexOf('-->', token.index)
        if (end === -1) {
          buffer = buffer.slice(token.index)
          return
        }
        p = end + 3
        continue
      }
      const gt = openTagEnd(token.index)
      if (gt === -1) {
        buffer = buffer.slice(token.index)
        return
      }
      const tag = buffer.slice(token.index, gt + 1)
      p = gt + 1
      if (token.kind === 'tv') {
        // The root is noted, never descended into — its children are found by the scan itself.
        sawTv = true
        continue
      }
      if (/\/\s*>$/.test(tag)) {
        // Self-closing: a complete element with no children — `<channel id="x"/>` is a real,
        // recordable channel (display name falls back to the id), not something to skip.
        openTag = tag
        body = ''
        overflowed = false
        parseOpenTag(tag)
        continue
      }
      inside = token.kind
      openTag = tag
      body = ''
      overflowed = false
    }
  }

  return {
    write(chunk: string): void {
      buffer += chunk
      process()
    },
    end(): XmltvGuide {
      if (inside) {
        throw new Error('Guide XML ended mid-element — the source is truncated or malformed')
      }
      if (!sawTv || !sawElement) {
        // Same sentence parseXmltv throws, for the same input shapes: no <tv> at all (HTML,
        // JSON, an error page), or a childless <tv></tv> (fast-xml-parser collapses that to an
        // empty string, which buildGuide rejects just the same).
        throw new Error('Not an XMLTV guide: no <tv> root element found in the response')
      }
      for (const list of programmesByChannel.values()) {
        list.sort((a, b) => a.startMs - b.startMs)
      }
      return { channels, programmesByChannel }
    }
  }
}

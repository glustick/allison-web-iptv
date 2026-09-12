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

function textOf(value: unknown): string | undefined {
  if (value == null) return undefined
  if (typeof value === 'string') return value
  if (typeof value === 'object' && '#text' in (value as Record<string, unknown>)) {
    return String((value as Record<string, unknown>)['#text'])
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

export function parseXmltv(xml: string, opts?: { now?: number }): XmltvGuide {
  const now = opts?.now ?? Date.now()
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' })
  const doc = parser.parse(xml) as { tv?: { channel?: unknown; programme?: unknown } }
  const tv = doc.tv ?? {}

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
      description: textOf(raw.desc)
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

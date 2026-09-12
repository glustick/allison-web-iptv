import { Writable } from 'stream'
import type { ServerResponse } from 'http'
import { createNodeUpstreamRequest } from './nodeUpstreamRequest.js'
import type { UpstreamClientRequest } from './proxyServer.js'
import { buildGuideIndexes, matchStreamToGuideChannel, type GuideIndexes, type StreamForMatching } from './epgMatching.js'
import { parseXmltv, type XmltvGuide } from './xmltv.js'

// Server-side EPG aggregation. The EPG used to be assembled entirely in the browser: one bulk
// ~98MB xmltv.php download per session (repeated per tab remount), joined to channels by exact
// epg_channel_id string only, with a per-channel get_short_epg fallback that this provider
// serves empty. This module moves aggregation behind /api/epg so it can merge the provider's
// guide with user-supplied external XMLTV sources (per-profile epgUrls), apply the wider
// matching layer from epgMatching.ts, and cache guides in server memory shared by every browser
// session — one fetch per source per TTL instead of one per tab.

const GUIDE_TTL_MS = 6 * 3_600_000
const CHANNEL_LIST_TTL_MS = 3_600_000
const MAX_REDIRECTS = 5

export interface EpgServiceCredentials {
  server: string
  username: string
  password: string
}

export interface EpgSourceStatus {
  kind: 'provider' | 'external'
  url: string
  status: 'ok' | 'error'
  channelCount: number
  programmeCount: number
  fetchedAt: number | null
  error?: string
}

export interface EpgWindowProgramme {
  startMs: number
  stopMs: number
  title: string
  description?: string
}

export interface EpgWindow {
  sources: EpgSourceStatus[]
  /** stream_id (as string, for JSON) → programmes overlapping the requested window */
  listings: Record<string, EpgWindowProgramme[]>
}

interface GuideCacheEntry {
  guide: XmltvGuide | null
  status: 'ok' | 'error'
  error?: string
  fetchedAt: number
  fetchPromise: Promise<XmltvGuide | null> | null
}

interface ChannelListCacheEntry {
  streams: StreamForMatching[]
  fetchedAt: number
}

export interface EpgServiceDeps {
  createUpstreamRequest?: typeof createNodeUpstreamRequest
  guideTtlMs?: number
  channelListTtlMs?: number
  now?: () => number
}

/** Fetches a URL's body as text through the Node upstream machinery (TLS-CA parity, redirect
 *  following, and the 20s mid-body stall watchdog all come along for free). */
function fetchTextViaUpstream(
  createUpstreamRequest: typeof createNodeUpstreamRequest,
  url: string
): Promise<string> {
  return new Promise((resolve, reject) => {
    const req: UpstreamClientRequest = createUpstreamRequest({ method: 'GET', url })
    let redirects = 0
    req.on('redirect', () => {
      if (redirects >= MAX_REDIRECTS) {
        req.abort()
        reject(new Error(`Too many redirects fetching ${url}`))
        return
      }
      redirects++
      req.followRedirect()
    })
    req.on('response', (res) => {
      if (res.statusCode >= 400) {
        req.abort()
        reject(new Error(`HTTP ${res.statusCode} fetching ${url}`))
        return
      }
      // A real Writable sink rather than a bare {write,end} object: Node's pipe() attaches
      // drain/error/close listeners on the destination and needs a genuine stream. 'finish' is
      // the normal completion; the watchdog's force-destroy path surfaces as 'close' (or an
      // 'error' on the request) without 'finish', which must reject rather than hang — a hung
      // guide fetch would otherwise wedge /api/epg exactly the way the old proxy hung players.
      const chunks: Buffer[] = []
      let settled = false
      const sink = new Writable({
        write(chunk: Buffer, _encoding, callback) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
          callback()
        }
      })
      sink.on('finish', () => {
        if (settled) return
        settled = true
        resolve(Buffer.concat(chunks).toString('utf-8'))
      })
      sink.on('close', () => {
        if (settled) return
        settled = true
        reject(new Error(`Connection closed before the guide finished downloading: ${url}`))
      })
      sink.on('error', (err) => {
        if (settled) return
        settled = true
        reject(err)
      })
      res.pipe(sink as unknown as ServerResponse)
    })
    req.on('error', (err) => reject(err instanceof Error ? err : new Error(String(err))))
    // `end` is deliberately not part of UpstreamClientRequest's own type (see that interface's
    // comment) even though the real object always has one — same cast nodeUpstreamRequest.test.ts
    // uses to send the "no request body coming" signal.
    ;(req as unknown as { end: () => void }).end()
  })
}

export function createEpgService(deps: EpgServiceDeps = {}) {
  const createUpstreamRequest = deps.createUpstreamRequest ?? createNodeUpstreamRequest
  const guideTtlMs = deps.guideTtlMs ?? GUIDE_TTL_MS
  const channelListTtlMs = deps.channelListTtlMs ?? CHANNEL_LIST_TTL_MS
  const now = deps.now ?? Date.now

  const guideCache = new Map<string, GuideCacheEntry>()
  const channelListCache = new Map<string, ChannelListCacheEntry>()

  function fetchGuideOnce(url: string): Promise<XmltvGuide | null> {
    return fetchTextViaUpstream(createUpstreamRequest, url).then((xml) => parseXmltv(xml, { now: now() }))
  }

  /** Cached guide fetch with stale-while-revalidate: a stale entry is served immediately while
   *  a refresh runs in the background; parallel callers share one refresh. */
  async function getGuide(url: string): Promise<GuideCacheEntry> {
    const existing = guideCache.get(url)
    if (existing) {
      if (now() - existing.fetchedAt < guideTtlMs) return existing
      if (!existing.fetchPromise) {
        existing.fetchPromise = fetchGuideOnce(url)
          .then((guide) => {
            guideCache.set(url, { guide, status: 'ok', fetchedAt: now(), fetchPromise: null })
            return guide
          })
          .catch((err) => {
            // A failed refresh keeps serving the last good guide — a temporarily unreachable
            // external source shouldn't blank rows it had already filled.
            existing.fetchPromise = null
            return existing.guide
          })
      }
      return existing
    }
    const fetched = await fetchGuideOnce(url)
    const entry: GuideCacheEntry = { guide: fetched, status: 'ok', fetchedAt: now(), fetchPromise: null }
    guideCache.set(url, entry)
    return entry
  }

  async function getGuideOrError(url: string): Promise<GuideCacheEntry> {
    try {
      return await getGuide(url)
    } catch (err) {
      const entry: GuideCacheEntry = {
        guide: null,
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
        fetchedAt: now(),
        fetchPromise: null
      }
      guideCache.set(url, entry)
      return entry
    }
  }

  async function getChannelList(credentials: EpgServiceCredentials): Promise<StreamForMatching[]> {
    const key = `${credentials.server}|${credentials.username}`
    const existing = channelListCache.get(key)
    if (existing && now() - existing.fetchedAt < channelListTtlMs) return existing.streams

    const url = `${providerBase(credentials)}/player_api.php?username=${encodeURIComponent(credentials.username)}&password=${encodeURIComponent(credentials.password)}&action=get_live_streams`
    const body = await fetchTextViaUpstream(createUpstreamRequest, url)
    const parsed = JSON.parse(body) as Array<{ stream_id?: unknown; name?: unknown; epg_channel_id?: unknown }>
    const streams: StreamForMatching[] = (Array.isArray(parsed) ? parsed : []).map((raw) => ({
      stream_id: Number(raw.stream_id),
      name: String(raw.name ?? ''),
      epg_channel_id: typeof raw.epg_channel_id === 'string' && raw.epg_channel_id.length > 0 ? raw.epg_channel_id : null
    })).filter((stream) => Number.isFinite(stream.stream_id))

    channelListCache.set(key, { streams, fetchedAt: now() })
    return streams
  }

  // The credential store keeps the server URL exactly as the user typed it (trailing slashes
  // included), so both provider URLs are built from a trimmed base.
  function providerBase(credentials: EpgServiceCredentials): string {
    return credentials.server.trim().replace(/\/+$/, '')
  }

  function providerGuideUrl(credentials: EpgServiceCredentials): string {
    return `${providerBase(credentials)}/xmltv.php?username=${encodeURIComponent(credentials.username)}&password=${encodeURIComponent(credentials.password)}`
  }

  function describeSource(kind: 'provider' | 'external', url: string, entry: GuideCacheEntry): EpgSourceStatus {
    return {
      kind,
      url,
      status: entry.status,
      channelCount: entry.guide?.channels.size ?? 0,
      programmeCount: entry.guide ? Array.from(entry.guide.programmesByChannel.values()).reduce((n, list) => n + list.length, 0) : 0,
      fetchedAt: entry.fetchedAt,
      error: entry.error
    }
  }

  async function aggregate(params: {
    credentials: EpgServiceCredentials
    epgUrls: string[]
    startMs?: number
    endMs?: number
  }): Promise<EpgWindow> {
    const { credentials, epgUrls } = params
    const sources = [providerGuideUrl(credentials), ...epgUrls]

    const [channelList, ...guideEntries] = await Promise.all([
      getChannelList(credentials).catch((err: unknown) => {
        throw new Error(`Could not load the channel list: ${err instanceof Error ? err.message : String(err)}`)
      }),
      ...sources.map((url) => getGuideOrError(url))
    ])

    // The provider guide wins per channel; external guides fill channels the provider has
    // nothing for, in the order they're configured.
    const providerEntry = guideEntries[0]
    const externalEntries = guideEntries.slice(1)
    const providerIndexes = providerEntry.guide ? buildGuideIndexes(providerEntry.guide) : null
    const externalIndexes = externalEntries.map((entry) => (entry.guide ? buildGuideIndexes(entry.guide) : null))
    const candidates: Array<{ guide: XmltvGuide; indexes: GuideIndexes }> = []
    if (providerEntry.guide && providerIndexes) candidates.push({ guide: providerEntry.guide, indexes: providerIndexes })
    externalEntries.forEach((entry, i) => {
      if (entry.guide && externalIndexes[i]) candidates.push({ guide: entry.guide, indexes: externalIndexes[i] as GuideIndexes })
    })

    const listings: Record<string, EpgWindowProgramme[]> = {}
    for (const stream of channelList) {
      for (const candidate of candidates) {
        const guideChannelId = matchStreamToGuideChannel(stream, candidate.indexes)
        if (!guideChannelId) continue
        const programmes = candidate.guide.programmesByChannel.get(guideChannelId)
        if (!programmes) continue
        const inWindow = programmes
          .filter((p) => params.startMs === undefined || params.endMs === undefined || (p.stopMs > params.startMs && p.startMs < params.endMs))
          .map((p) => ({ startMs: p.startMs, stopMs: p.stopMs, title: p.title, description: p.description }))
        if (inWindow.length > 0) listings[String(stream.stream_id)] = inWindow
        break
      }
    }

    return {
      sources: sources.map((url, i) =>
        describeSource(i === 0 ? 'provider' : 'external', url, guideEntries[i])
      ),
      listings
    }
  }

  return {
    aggregate,
    /** Kept out of aggregate() so a status poll never builds listings. */
    getStatus(params: { credentials: EpgServiceCredentials; epgUrls: string[] }): Promise<EpgSourceStatus[]> {
      const sources = [providerGuideUrl(params.credentials), ...params.epgUrls]
      return Promise.all(sources.map((url, i) =>
        getGuideOrError(url).then((entry) => describeSource(i === 0 ? 'provider' : 'external', url, entry))
      ))
    },
    /** Test/ops hook: drop cached guides (channel-list cache keyed to its own shorter TTL). */
    clearGuideCache(): void {
      guideCache.clear()
    }
  }
}

export type EpgService = ReturnType<typeof createEpgService>

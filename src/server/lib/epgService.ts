import { fetchTextViaUpstream } from './upstreamText.js'
import type { ServerResponse } from 'http'
import { createNodeUpstreamRequest } from './nodeUpstreamRequest.js'
import type { UpstreamClientRequest } from './proxyServer.js'
import {
  buildGuideIndexes,
  matchStreamToGuideChannelDetailed,
  type GuideIndexes,
  type MatchStrategy,
  type StreamForMatching
} from './epgMatching.js'
import { parseXmltv, type XmltvGuide, type XmltvProgramme } from './xmltv.js'

// Server-side EPG aggregation. The EPG used to be assembled entirely in the browser: one bulk
// ~98MB xmltv.php download per session (repeated per tab remount), joined to channels by exact
// epg_channel_id string only, with a per-channel get_short_epg fallback that this provider
// serves empty. This module moves aggregation behind /api/epg so it can merge the provider's
// guide with user-supplied external XMLTV sources (per-account epgUrls), apply the wider
// matching layer from epgMatching.ts, and cache guides in server memory shared by every browser
// session — one fetch per source per TTL instead of one per tab.
//
// v0.6.6 adds the caches that make thousands of channels practical: guide indexes are built once
// per fetched guide (not per request), programme counts are computed once, the stream→guide
// mapping is memoised per (account, guide version) so grid navigation only re-runs the cheap
// window filter, and window filtering binary-searches the parser's already-sorted programme
// lists instead of scanning every programme of every matched channel.

const GUIDE_TTL_MS = 6 * 3_600_000
const CHANNEL_LIST_TTL_MS = 3_600_000
// A source that failed is retried after this long rather than sitting in the error state until
// its 6h TTL expires — but with exponential backoff, because a guide fetch is not cheap: the
// provider's own guide is ~97MB, and retrying that every minute while it keeps failing is a good
// way to get rate-limited (or look like an attack) while achieving nothing.
export const EPG_ERROR_RETRY_BASE_MS = 60_000
export const EPG_ERROR_RETRY_MAX_MS = 15 * 60_000

/** 1st failure waits 60s, then 2m, 4m … capped at 15m; reset on any success. */
export function epgRetryDelayMs(failures: number): number {
  if (!Number.isFinite(failures) || failures <= 0) return EPG_ERROR_RETRY_BASE_MS
  return Math.min(EPG_ERROR_RETRY_MAX_MS, EPG_ERROR_RETRY_BASE_MS * 2 ** (failures - 1))
}

// Bulk guide downloads get a far longer stall window than the stream-oriented default (20s in
// nodeUpstreamRequest.ts): a ~97MB XMLTV transfer pausing >20s mid-body is normal on a busy
// provider or a home link, and treating that as a failure is what surfaced as a "provider EPG
// error" on one deployment while the provider answered fine when fetched directly.
const GUIDE_STALL_TIMEOUT_MS = 120_000

// The channel list is a smaller bulk download (~10MB) but comes from the same busy endpoint, so
// it gets a longer-than-default window too. Both apply only to EPG work; streams keep the snappy
// 20s default so a dead stream still fails fast for the player.
const CHANNEL_LIST_STALL_TIMEOUT_MS = 60_000
const MAX_REDIRECTS = 5

export interface EpgServiceCredentials {
  server: string
  username: string
  password: string
}

export type EpgSourceState = 'ok' | 'error' | 'loading'

export interface EpgSourceStatus {
  kind: 'provider' | 'external'
  url: string
  status: EpgSourceState
  channelCount: number
  programmeCount: number
  fetchedAt: number | null
  error?: string
}

export interface EpgMatchSummary {
  streams: number
  matched: number
  unmatched: number
  byStrategy: Record<MatchStrategy, number>
  /**
   * How many channels each guide source answered for, most useful first.
   *
   * The overall totals say how well matching went; this says *who* did the matching, which is what you
   * need when one source covers a whole region and another contributes almost nothing — or when a
   * source you added is not being consulted at all.
   */
  bySource: { url: string; matched: number }[]
  buildMs: number
  builtAt: number
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
  fetchPromise: Promise<GuideCacheEntry> | null
  /** Consecutive failures, for the retry backoff. */
  failures?: number
  /** Earliest time this URL may be retried. */
  nextRetryAt?: number
  /** Built lazily once per guide (see buildGuideIndexes) and reused by every request. */
  index?: GuideIndexes | null
  channelCount?: number
  programmeCount?: number
}

interface ChannelListCacheEntry {
  streams: StreamForMatching[]
  fetchedAt: number
}

interface StreamMatch {
  guideUrl: string
  channelId: string
  strategy: MatchStrategy
  score?: number
}

interface MappingCacheEntry {
  mapping: Map<number, StreamMatch>
  stats: EpgMatchSummary
  key: string
}

export interface EpgServiceDeps {
  createUpstreamRequest?: typeof createNodeUpstreamRequest
  guideTtlMs?: number
  channelListTtlMs?: number
  /** Overridable for tests; production uses GUIDE_STALL_TIMEOUT_MS. */
  guideStallTimeoutMs?: number
  /** Overridable for tests; production uses nodeUpstreamRequest's own check interval. */
  guideStallCheckIntervalMs?: number
  now?: () => number
}

/** Programmes overlapping [startMs, endMs) from a list the parser already sorted by startMs. */
function programmesInWindow(sorted: XmltvProgramme[], startMs?: number, endMs?: number): XmltvProgramme[] {
  if (startMs === undefined || endMs === undefined) return sorted
  // First index whose programme starts at/after the window — then step back over any earlier
  // programme that still overlaps the window (normally zero or one step).
  let lo = 0
  let hi = sorted.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (sorted[mid].startMs < startMs) lo = mid + 1
    else hi = mid
  }
  let start = lo
  while (start > 0 && sorted[start - 1].stopMs > startMs) start--
  const out: XmltvProgramme[] = []
  for (let i = start; i < sorted.length && sorted[i].startMs < endMs; i++) {
    if (sorted[i].stopMs > startMs) out.push(sorted[i])
  }
  return out
}

export function createEpgService(deps: EpgServiceDeps = {}) {
  const createUpstreamRequest = deps.createUpstreamRequest ?? createNodeUpstreamRequest
  const guideTtlMs = deps.guideTtlMs ?? GUIDE_TTL_MS
  const channelListTtlMs = deps.channelListTtlMs ?? CHANNEL_LIST_TTL_MS
  const guideStallTimeoutMs = deps.guideStallTimeoutMs ?? GUIDE_STALL_TIMEOUT_MS
  const guideStallCheckIntervalMs = deps.guideStallCheckIntervalMs
  const now = deps.now ?? Date.now

  const guideCache = new Map<string, GuideCacheEntry>()
  const channelListCache = new Map<string, ChannelListCacheEntry>()
  const mappingCache = new Map<string, MappingCacheEntry>()
  /** Last computed match summary per account — lets the EPG screen show coverage stats that
   *  were produced by a normal grid load, without recomputing them on every settings poll. */
  const lastSummary = new Map<string, EpgMatchSummary>()

  function ensureGuideStats(entry: GuideCacheEntry): void {
    if (entry.programmeCount !== undefined) return
    entry.channelCount = entry.guide?.channels.size ?? 0
    entry.programmeCount = entry.guide
      ? Array.from(entry.guide.programmesByChannel.values()).reduce((n, list) => n + list.length, 0)
      : 0
  }

  /** The guide's channel indexes — built once per fetched guide, not per request. */
  function ensureIndex(entry: GuideCacheEntry): GuideIndexes | null {
    if (entry.index !== undefined) return entry.index
    entry.index = entry.guide ? buildGuideIndexes(entry.guide) : null
    return entry.index
  }

  function fetchGuideOnce(url: string): Promise<XmltvGuide | null> {
    return fetchTextViaUpstream(createUpstreamRequest, url, guideStallTimeoutMs, guideStallCheckIntervalMs).then((xml) =>
      parseXmltv(xml, { now: now() })
    )
  }

  /**
   * Runs a fetch and records its outcome (success, or an error with the retry backoff).
   * Concurrent callers share one in-flight fetch.
   */
  function runFetch(url: string): Promise<GuideCacheEntry> {
    const inFlight = guideCache.get(url)?.fetchPromise
    if (inFlight) return inFlight.then(() => guideCache.get(url) as GuideCacheEntry)

    const promise = fetchGuideOnce(url)
      .then((guide) => {
        const success: GuideCacheEntry = { guide, status: 'ok', fetchedAt: now(), fetchPromise: null, failures: 0 }
        guideCache.set(url, success)
        return success
      })
      .catch((err) => {
        const failures = (guideCache.get(url)?.failures ?? 0) + 1
        const failed: GuideCacheEntry = {
          guide: null,
          status: 'error',
          error: err instanceof Error ? err.message : String(err),
          fetchedAt: now(),
          fetchPromise: null,
          failures,
          nextRetryAt: now() + epgRetryDelayMs(failures)
        }
        guideCache.set(url, failed)
        return failed
      })

    const current: GuideCacheEntry = guideCache.get(url) ?? {
      guide: null,
      status: 'error',
      error: 'not fetched yet',
      fetchedAt: now(),
      fetchPromise: null
    }
    current.fetchPromise = promise
    guideCache.set(url, current)
    return promise
  }

  /**
   * Cached guide entry, refreshing when due.
   *
   * Error entries are retried once their backoff has elapsed — and *only* then, in the
   * background. Previously a cached entry younger than its 6h TTL was returned as-is whatever
   * its status, so a single failure parked the source in a frozen error/"loading" state for six
   * hours with no retry at all (the reported stuck provider guide, whose last attempt was hours
   * old). Background, because the retry may be another ~97MB download and a grid request must
   * not wait on it.
   */
  async function getGuide(url: string): Promise<GuideCacheEntry> {
    const existing = guideCache.get(url)
    // Nothing cached: load it now — the caller is asking for data.
    if (!existing) return runFetch(url)

    if (existing.status === 'ok' && now() - existing.fetchedAt < guideTtlMs) return existing

    const retryDue = existing.status === 'error' && now() >= (existing.nextRetryAt ?? 0)

    // A fetch is already running and there is nothing usable to serve yet: wait for it rather
    // than handing back an empty placeholder (this is the path a cold load takes when the
    // settings screen has already kicked the same fetch off).
    if (existing.fetchPromise && existing.guide === null) return existing.fetchPromise

    if (existing.status === 'ok') {
      // Stale but servable: serve it and revalidate in the background.
      if (!existing.fetchPromise) void runFetch(url)
      return existing
    }

    // Failed source: retry only once the backoff has elapsed, and never make a grid request wait
    // on what may be another ~97MB download.
    if (retryDue && !existing.fetchPromise) void runFetch(url)
    return existing
  }

  async function getGuideOrError(url: string): Promise<GuideCacheEntry> {
    // Outcomes (including failures) are recorded in the cache rather than thrown, so callers
    // always get an entry describing the source's state.
    return getGuide(url)
  }

  /** Non-blocking status for the EPG settings screen: reports what is cached, and for anything
   *  missing/re-fetchable starts the download in the background so the UI can poll for it. */
  function peekStatus(urls: string[]): EpgSourceStatus[] {
    return urls.map((url, i) => {
      const kind: 'provider' | 'external' = i === 0 ? 'provider' : 'external'
      const entry = guideCache.get(url)
      if (!entry) {
        void getGuideOrError(url)
        return { kind, url, status: 'loading' as EpgSourceState, channelCount: 0, programmeCount: 0, fetchedAt: null }
      }
      ensureGuideStats(entry)
      const stale = now() - entry.fetchedAt >= guideTtlMs
      const retryDue = entry.status === 'error' && now() >= (entry.nextRetryAt ?? entry.fetchedAt + EPG_ERROR_RETRY_BASE_MS)
      // Trigger the (background) refresh through the same path everything else uses.
      if ((stale || retryDue) && !entry.fetchPromise) void getGuideOrError(url)
      const refreshing = Boolean(entry.fetchPromise)
      return {
        kind,
        url,
        // An errored source that is merely waiting out its backoff reports 'error' with its real
        // message, not a 'loading' that never resolves — which is how it looked before.
        status: refreshing || stale ? 'loading' : entry.status,
        channelCount: entry.channelCount ?? 0,
        programmeCount: entry.programmeCount ?? 0,
        fetchedAt: entry.fetchedAt,
        error: entry.error
      }
    })
  }

  async function getChannelList(credentials: EpgServiceCredentials): Promise<StreamForMatching[]> {
    const key = `${credentials.server}|${credentials.username}`
    const existing = channelListCache.get(key)
    if (existing && now() - existing.fetchedAt < channelListTtlMs) return existing.streams

    const url = `${providerBase(credentials)}/player_api.php?username=${encodeURIComponent(credentials.username)}&password=${encodeURIComponent(credentials.password)}&action=get_live_streams`
    const body = await fetchTextViaUpstream(createUpstreamRequest, url, CHANNEL_LIST_STALL_TIMEOUT_MS)
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
    ensureGuideStats(entry)
    return {
      kind,
      url,
      status: entry.status,
      channelCount: entry.channelCount ?? 0,
      programmeCount: entry.programmeCount ?? 0,
      fetchedAt: entry.fetchedAt,
      error: entry.error
    }
  }

  function mappingCacheKey(
    credentials: EpgServiceCredentials,
    sources: string[],
    entries: GuideCacheEntry[]
  ): string {
    const versions = entries.map((entry) => `${entry.fetchedAt}:${entry.status}`).join(',')
    return `${credentials.server}|${credentials.username}|${sources.join('\u0000')}|${versions}`
  }

  /** Stream → guide-channel mapping, memoised per (account, source set, guide versions): this is
   *  the expensive part (thousands of streams × scoring), so it runs once per guide refresh
   *  rather than per grid navigation. */
  function getMapping(
    credentials: EpgServiceCredentials,
    sources: string[],
    entries: GuideCacheEntry[],
    streams: StreamForMatching[]
  ): MappingCacheEntry {
    const key = mappingCacheKey(credentials, sources, entries)
    const cached = mappingCache.get(key)
    if (cached) return cached

    const startedAt = now()
    const candidates: Array<{ url: string; index: GuideIndexes }> = []
    entries.forEach((entry, i) => {
      const index = ensureIndex(entry)
      if (entry.guide && index) candidates.push({ url: sources[i], index })
    })

    const mapping = new Map<number, StreamMatch>()
    const byStrategy: Record<MatchStrategy, number> = {
      'exact-id': 0,
      'normalized-id': 0,
      'exact-name': 0,
      'fuzzy-name': 0
    }
    // Which source answered, per source: the same matches, attributed to the guide they came from.
    const matchesBySource = new Map<string, number>()
    for (const stream of streams) {
      for (const candidate of candidates) {
        const result = matchStreamToGuideChannelDetailed(stream, candidate.index)
        if (!result.channelId || !result.strategy) continue
        mapping.set(stream.stream_id, {
          guideUrl: candidate.url,
          channelId: result.channelId,
          strategy: result.strategy,
          score: result.score
        })
        byStrategy[result.strategy]++
        matchesBySource.set(candidate.url, (matchesBySource.get(candidate.url) ?? 0) + 1)
        break
      }
    }

    const entry: MappingCacheEntry = {
      mapping,
      key,
      stats: {
        streams: streams.length,
        matched: mapping.size,
        unmatched: streams.length - mapping.size,
        byStrategy,
        bySource: [...matchesBySource.entries()]
          .map(([url, matched]) => ({ url, matched }))
          .sort((a, b) => b.matched - a.matched),
        buildMs: Math.max(0, now() - startedAt),
        builtAt: now()
      }
    }
    // One mapping per account in practice; keep the map small.
    if (mappingCache.size > 8) mappingCache.clear()
    mappingCache.set(key, entry)
    lastSummary.set(`${credentials.server}|${credentials.username}`, entry.stats)
    return entry
  }

  async function resolveEverything(params: { credentials: EpgServiceCredentials; epgUrls: string[] }): Promise<{
    streams: StreamForMatching[]
    sources: string[]
    entries: GuideCacheEntry[]
    mapping: MappingCacheEntry
  }> {
    const sources = [providerGuideUrl(params.credentials), ...params.epgUrls]
    const [streams, ...entries] = await Promise.all([
      getChannelList(params.credentials).catch((err: unknown) => {
        throw new Error(`Could not load the channel list: ${err instanceof Error ? err.message : String(err)}`)
      }),
      ...sources.map((url) => getGuideOrError(url))
    ])
    const mapping = getMapping(params.credentials, sources, entries, streams)
    return { streams, sources, entries, mapping }
  }

  async function aggregate(params: {
    credentials: EpgServiceCredentials
    epgUrls: string[]
    startMs?: number
    endMs?: number
  }): Promise<EpgWindow> {
    const { sources, entries, mapping } = await resolveEverything(params)
    const guidesByUrl = new Map<string, XmltvGuide>()
    entries.forEach((entry, i) => {
      if (entry.guide) guidesByUrl.set(sources[i], entry.guide)
    })

    const listings: Record<string, EpgWindowProgramme[]> = {}
    for (const [streamId, match] of mapping.mapping) {
      const guide = guidesByUrl.get(match.guideUrl)
      if (!guide) continue
      const programmes = guide.programmesByChannel.get(match.channelId)
      if (!programmes || programmes.length === 0) continue
      const inWindow = programmesInWindow(programmes, params.startMs, params.endMs)
      if (inWindow.length === 0) continue
      listings[String(streamId)] = inWindow.map((p) => ({
        startMs: p.startMs,
        stopMs: p.stopMs,
        title: p.title,
        description: p.description
      }))
    }

    return {
      sources: sources.map((url, i) => describeSource(i === 0 ? 'provider' : 'external', url, entries[i])),
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
    /** Non-blocking status used by the EPG settings screen (starts missing fetches in the
     *  background, reports 'loading' meanwhile). */
    peekStatus(params: { credentials: EpgServiceCredentials; epgUrls: string[] }): EpgSourceStatus[] {
      return peekStatus([providerGuideUrl(params.credentials), ...params.epgUrls])
    },
    /** How many channels the guides actually cover, and by which matching step. */
    getMatchSummary(params: { credentials: EpgServiceCredentials; epgUrls: string[] }): Promise<EpgMatchSummary> {
      return resolveEverything(params).then((resolved) => resolved.mapping.stats)
    },
    /** The last computed summary for this account, if any (no fetch, no recompute). */
    peekMatchSummary(params: { credentials: EpgServiceCredentials }): EpgMatchSummary | null {
      return lastSummary.get(`${params.credentials.server}|${params.credentials.username}`) ?? null
    },
    /** Drops cached guides (and the mappings derived from them) so the next request refetches,
     *  then starts those fetches in the background. Used by the EPG screen's "Refresh" action. */
    refresh(params: { credentials: EpgServiceCredentials; epgUrls: string[] }): void {
      const sources = [providerGuideUrl(params.credentials), ...params.epgUrls]
      for (const url of sources) guideCache.delete(url)
      mappingCache.clear()
      lastSummary.delete(`${params.credentials.server}|${params.credentials.username}`)
      for (const url of sources) void getGuideOrError(url)
    },
    /** Test/ops hook: drop cached guides (channel-list cache keyed to its own shorter TTL). */
    clearGuideCache(): void {
      guideCache.clear()
      mappingCache.clear()
    }
  }
}

export type EpgService = ReturnType<typeof createEpgService>

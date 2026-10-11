import { createReadStream } from 'fs'
import { StringDecoder } from 'string_decoder'
import { fetchTextViaUpstream } from './upstreamText.js'
import type { ServerResponse } from 'http'
import { createNodeUpstreamRequest } from './nodeUpstreamRequest.js'
import type { UpstreamClientRequest } from './proxyServer.js'
import {
  buildGuideIndexes,
  channelTokens,
  matchStreamToGuideChannelDetailed,
  tokenSetScore,
  type GuideIndexes,
  type MatchStrategy,
  type StreamForMatching
} from './epgMatching.js'
import type { XmltvGuide, XmltvProgramme } from './xmltv.js'
import { createXmltvStreamParser } from './xmltvStream.js'
import { dropCachedGuide, saveCachedGuide, statCachedGuide } from './epgCache.js'

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

// A guide is fetched **once a day**. The operator asked for exactly that (2026-09-28): the guide
// changes slowly, the provider's own is a 168 MB download, and re-fetching it per login or on every
// restart is work nobody asked for. The on-disk cache (epgCache.ts) is what makes that day survive
// a restart rather than restarting the clock.
const GUIDE_TTL_MS = 24 * 3_600_000
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
  /** Download progress while a guide is loading — and where a failed download got to. */
  progress?: { receivedBytes: number; totalBytes: number | null } | null
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
  /** Download progress while a fetch is in flight — and, after it ends, where it got to.
   *  A stalled ~97MB provider guide used to be indistinguishable from a working one. */
  progress?: { receivedBytes: number; totalBytes: number | null } | null
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
  /** Where fetched guides are cached across restarts (epgCache.ts). Omitted = memory only. */
  dataDir?: string
  channelListTtlMs?: number
  /** Overridable for tests; production uses GUIDE_STALL_TIMEOUT_MS. */
  guideStallTimeoutMs?: number
  /** Overridable for tests; production uses nodeUpstreamRequest's own check interval. */
  guideStallCheckIntervalMs?: number
  now?: () => number
  /**
   * The account's manual channel→guide overrides (guideMappings.ts), consulted before every
   * automatic tier (v0.76.0). Optional so existing wirings compile untouched — without it the
   * service behaves exactly as before, automatic matching only.
   */
  manualMappings?: {
    /** playlistId '' is the primary playlist (v0.78.0 widening; primary-only callers pass ''). */
    get(owner: string, playlistId: string, streamId: number): { guideChannelId: string; guideChannelName: string; setAt: number } | null
  }
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
  const manualMappings = deps.manualMappings
  const guideTtlMs = deps.guideTtlMs ?? GUIDE_TTL_MS
  const channelListTtlMs = deps.channelListTtlMs ?? CHANNEL_LIST_TTL_MS
  const guideStallTimeoutMs = deps.guideStallTimeoutMs ?? GUIDE_STALL_TIMEOUT_MS
  const guideStallCheckIntervalMs = deps.guideStallCheckIntervalMs
  const dataDir = deps.dataDir
  const now = deps.now ?? Date.now

  const guideCache = new Map<string, GuideCacheEntry>()
  // URLs whose disk copy must be ignored until the next fetch settles — a forced refresh has to
  // mean "discard what you have", and without this the disk cache would answer it immediately with
  // the very guide the operator just asked to replace.
  const hydrationBlocked = new Set<string>()
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

  function fetchGuideOnce(
    url: string,
    onProgress?: (receivedBytes: number, totalBytes: number | null) => void
  ): Promise<{ guide: XmltvGuide; text: string }> {
    return fetchTextViaUpstream(createUpstreamRequest, url, guideStallTimeoutMs, guideStallCheckIntervalMs, undefined, onProgress).then(async (xml) => ({
      // Queued with hydration: the nightly warm fetches every source at once, and even a
      // streaming parse holds one guide's retained data — one at a time is the peak.
      guide: await queueParse(() => parseXmltvText(xml)),
      // The bytes are kept so the guide can be cached on disk as well as in memory — see
      // epgCache.ts for why a restart must not re-download a 168 MB guide.
      text: xml
    }))
  }

  /**
   * The streaming parser over text that is already fully in memory (the fetch path), fed in
   * slices so the parser's working buffer stays small. Replaces the DOM parse, whose footprint
   * for a single ~170MB guide measured ~1.3GB on this repo's rig — the deployment's guide set
   * grew past that, and every parse was an OOM (see xmltvStream.ts).
   */
  function parseXmltvText(xml: string): XmltvGuide {
    const parser = createXmltvStreamParser({ now: now() })
    const SLICE = 4 * 1024 * 1024
    for (let i = 0; i < xml.length; i += SLICE) parser.write(xml.slice(i, i + SLICE))
    return parser.end()
  }

  /** One parse at a time across all sources: the peak is one guide's retained data plus a
   *  small scanner buffer, never three concurrent builds. */
  let parseChain: Promise<unknown> = Promise.resolve()
  function queueParse<T>(job: () => T | Promise<T>): Promise<T> {
    const run = parseChain.then(async () => await job(), async () => await job())
    parseChain = run.catch(() => {})
    return run
  }

  /** Streams the cached guide file through the parser — no point in the document's life is it
   *  held in memory whole. Returns the guide, or rethrows whatever the parser threw. */
  function parseGuideFile(path: string): Promise<XmltvGuide> {
    const parser = createXmltvStreamParser({ now: now() })
    const decoder = new StringDecoder('utf8')
    return new Promise<XmltvGuide>((resolve, reject) => {
      const stream = createReadStream(path, { highWaterMark: 1 << 20 })
      stream.on('data', (chunk: Buffer | string) => {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        try {
          parser.write(decoder.write(buf))
        } catch (err) {
          stream.destroy()
          reject(err instanceof Error ? err : new Error(String(err)))
        }
      })
      stream.on('end', () => {
        try {
          resolve(parser.end())
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)))
        }
      })
      stream.on('error', reject)
    })
  }

  /**
   * The guide from the disk cache, when it is still inside the daily window — what makes a restart
   * (a deploy, a reboot) not re-download what the day already paid for. Parsed on first need rather
   * than at boot, so a server that never opens the EPG never pays for it either.
   */
  async function hydrateGuideFromDisk(url: string): Promise<GuideCacheEntry | null> {
    if (!dataDir || hydrationBlocked.has(url)) return null
    const cached = await statCachedGuide(dataDir, url, guideTtlMs)
    if (!cached) return null
    try {
      // Queued + streamed: the old shape read the file to a string and DOM-parsed it, whose
      // ~1.3GB-per-guide spike (measured on this repo's rig for a 195MB guide) is what OOM'd
      // the deployment once its guide set grew to ~400MB — every restart re-hydrated on first
      // need and died. The stream parser holds a small buffer; queueParse keeps concurrent
      // source hydrations from stacking their retained guides during the parse phase.
      const guide = await queueParse(() => parseGuideFile(cached.path))
      const entry: GuideCacheEntry = {
        guide,
        status: 'ok',
        fetchedAt: cached.fetchedAt,
        fetchPromise: null,
        failures: 0
      }
      guideCache.set(url, entry)
      return entry
    } catch (err) {
      // A cached guide that no longer parses is worth nothing; drop it and fetch instead.
      console.error(`[epg] cached guide could not be parsed, refetching:`, err instanceof Error ? err.message : err)
      void dropCachedGuide(dataDir, url)
      return null
    }
  }

  /** One hydration per URL at a time, so a burst of requests after a restart parses once. */
  const hydrations = new Map<string, Promise<GuideCacheEntry | null>>()
  function hydrateOnce(url: string): Promise<GuideCacheEntry | null> {
    const inFlight = hydrations.get(url)
    if (inFlight) return inFlight
    const promise = hydrateGuideFromDisk(url).finally(() => hydrations.delete(url))
    hydrations.set(url, promise)
    return promise
  }

  /**
   * Runs a fetch and records its outcome (success, or an error with the retry backoff).
   * Concurrent callers share one in-flight fetch.
   */
  function runFetch(url: string): Promise<GuideCacheEntry> {
    const inFlight = guideCache.get(url)?.fetchPromise
    if (inFlight) return inFlight.then(() => guideCache.get(url) as GuideCacheEntry)

    // The cache entry goes in BEFORE the fetch starts: the download's progress callbacks update
    // it in place, which is what the status poll reads while the ~97MB guide is in flight.
    const current: GuideCacheEntry = guideCache.get(url) ?? {
      guide: null,
      status: 'error',
      error: 'not fetched yet',
      fetchedAt: now(),
      fetchPromise: null
    }
    const promise = fetchGuideOnce(url, (receivedBytes, totalBytes) => {
      current.progress = { receivedBytes, totalBytes }
    })
      .then(async ({ guide, text }) => {
        // Cached for the next restart. Awaited only so the entry can carry the file's own
        // fetched-at; a failure to write never fails the fetch.
        const fetchedAt = dataDir ? await saveCachedGuide(dataDir, url, text) : now()
        hydrationBlocked.delete(url)
        const success: GuideCacheEntry = {
          guide, status: 'ok', fetchedAt, fetchPromise: null, failures: 0,
          progress: current.progress
        }
        guideCache.set(url, success)
        return success
      })
      .catch((err) => {
        // The attempt is over, so a later look may hydrate the previous disk copy again — the
        // failed refresh should not leave the source permanently unable to fall back.
        hydrationBlocked.delete(url)
        const failures = (guideCache.get(url)?.failures ?? 0) + 1
        const failed: GuideCacheEntry = {
          guide: null,
          status: 'error',
          error: err instanceof Error ? err.message : String(err),
          fetchedAt: now(),
          fetchPromise: null,
          failures,
          nextRetryAt: now() + epgRetryDelayMs(failures),
          // Where the download died — bytes received before the failure — which turns "error"
          // into a diagnosis when the provider's edge drops a ~97MB transfer midway.
          progress: current.progress
        }
        guideCache.set(url, failed)
        return failed
      })

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
    // Nothing cached: a fresh process, or the first look at this source. Reuse the day's cached
    // download from disk before paying for it again over the network.
    if (!existing) {
      const hydrated = await hydrateOnce(url)
      if (hydrated) return hydrated
      return runFetch(url)
    }

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
        return { kind, url, status: 'loading' as EpgSourceState, channelCount: 0, programmeCount: 0, fetchedAt: null, progress: null }
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
        error: entry.error,
        progress: entry.progress ?? null
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
      error: entry.error,
      progress: entry.progress ?? null
    }
  }

  function mappingCacheKey(
    credentials: EpgServiceCredentials,
    sources: string[],
    entries: GuideCacheEntry[],
    manual?: Map<number, string>,
    playlistId = ''
  ): string {
    const versions = entries.map((entry) => `${entry.fetchedAt}:${entry.status}`).join(',')
    // The overrides are part of the mapping's identity: set/clear must invalidate the cache,
    // or the operator's fix would not appear until the next guide refresh.
    const overrides = manual
      ? [...manual.entries()].sort((a, b) => a[0] - b[0]).map(([id, gid]) => `${id}=${gid}`).join(',')
      : ''
    // The playlist dimension (v0.78.0): two playlists that share a provider account would
    // otherwise share one mapping cache entry while their manual overrides differ.
    return `${playlistId}|${credentials.server}|${credentials.username}|${sources.join('\u0000')}|${versions}|${overrides}`
  }

  /** Stream → guide-channel mapping, memoised per (playlist, account, source set, guide versions):
   *  this is the expensive part (thousands of streams × scoring), so it runs once per guide
   *  refresh rather than per grid navigation. */
  function getMapping(
    credentials: EpgServiceCredentials,
    sources: string[],
    entries: GuideCacheEntry[],
    streams: StreamForMatching[],
    playlistId = ''
  ): MappingCacheEntry {
    const manual = new Map<number, string>()
    if (manualMappings) {
      for (const stream of streams) {
        const override = manualMappings.get(credentials.username, playlistId, stream.stream_id)
        if (override) manual.set(stream.stream_id, override.guideChannelId)
      }
    }
    const key = mappingCacheKey(credentials, sources, entries, manual, playlistId)
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
      'fuzzy-name': 0,
      // Counted like the automatic strategies so the coverage stats stay one shape.
      'manual': 0
    }
    // Which source answered, per source: the same matches, attributed to the guide they came from.
    const matchesBySource = new Map<string, number>()
    for (const stream of streams) {
      // The operator's override first (v0.76.0): a manual mapping wins over every automatic
      // tier, and it resolves against whichever guide source actually carries the target
      // channel id. A mapping whose guide channel no longer exists simply falls through to
      // the automatic tiers — never to another channel's row.
      const override = manual.get(stream.stream_id)
      if (override) {
        const source = candidates.find((candidate) => candidate.index.exactIds.has(override))
        if (source) {
          mapping.set(stream.stream_id, {
            guideUrl: source.url,
            channelId: override,
            strategy: 'manual'
          })
          byStrategy.manual++
          matchesBySource.set(source.url, (matchesBySource.get(source.url) ?? 0) + 1)
          continue
        }
      }
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
    // Only the primary's summary feeds the config screen's peek (peekMatchSummary reads '').
    lastSummary.set(`${playlistId}|${credentials.server}|${credentials.username}`, entry.stats)
    return entry
  }

  async function resolveEverything(params: {
    credentials: EpgServiceCredentials
    epgUrls: string[]
    playlistId?: string
  }): Promise<{
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
    const mapping = getMapping(params.credentials, sources, entries, streams, params.playlistId ?? '')
    return { streams, sources, entries, mapping }
  }

  /**
   * One playlist's programmes for the window. `playlistId` is the composite-key decision: ''
   * (the primary playlist) keys listings by the bare stream id — every consumer since the
   * first guide does, and legacy caches keep matching — while a non-primary playlist keys by
   * `<playlistId>:<streamId>`, so two playlists handing out the same provider-scoped id can
   * never overwrite each other's programmes.
   */
  async function aggregateOne(params: {
    playlistId: string
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
    const keyFor = params.playlistId === ''
      ? (streamId: number) => String(streamId)
      : (streamId: number) => `${params.playlistId}:${streamId}`
    for (const [streamId, match] of mapping.mapping) {
      const guide = guidesByUrl.get(match.guideUrl)
      if (!guide) continue
      const programmes = guide.programmesByChannel.get(match.channelId)
      if (!programmes || programmes.length === 0) continue
      const inWindow = programmesInWindow(programmes, params.startMs, params.endMs)
      if (inWindow.length === 0) continue
      listings[keyFor(streamId)] = inWindow.map((p) => ({
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

  async function aggregate(params: {
    credentials: EpgServiceCredentials
    epgUrls: string[]
    startMs?: number
    endMs?: number
  }): Promise<EpgWindow> {
    return aggregateOne({ playlistId: '', credentials: params.credentials, epgUrls: params.epgUrls, startMs: params.startMs, endMs: params.endMs })
  }

  /**
   * Every playlist's programmes in one response (v0.78.0). Each playlist resolves its own
   * provider guide plus the shared household sources, and matches its own channels — one
   * playlist's provider being down must not blank the others (independent failures, the same
   * rule the channel merge follows). The response only fails when NO playlist resolved.
   * `sources` is the union across playlists, deduped by URL — the household's XMLTV sources
   * are shared, so the same URL is fetched once no matter how many playlists see it.
   */
  async function aggregatePlaylists(params: {
    playlists: Array<{ playlistId: string; credentials: EpgServiceCredentials }>
    epgUrls: string[]
    startMs?: number
    endMs?: number
  }): Promise<EpgWindow> {
    const settled = await Promise.allSettled(
      params.playlists.map((entry) =>
        aggregateOne({
          playlistId: entry.playlistId,
          credentials: entry.credentials,
          epgUrls: params.epgUrls,
          startMs: params.startMs,
          endMs: params.endMs
        })
      )
    )
    const windows = settled
      .map((result, i) => {
        if (result.status === 'fulfilled') return result.value
        const label = params.playlists[i]?.playlistId || 'primary'
        // One playlist failing is that playlist's problem; the grid shows its rows empty.
        console.error(`[epg] playlist "${label}" failed to aggregate:`, result.reason)
        return null
      })
      .filter((value): value is EpgWindow => value !== null)
    if (windows.length === 0) {
      const first = settled.find((result): result is PromiseRejectedResult => result.status === 'rejected')
      throw first?.reason instanceof Error ? first.reason : new Error('No playlist produced a guide')
    }

    const seen = new Set<string>()
    const sources: EpgSourceStatus[] = []
    const listings: Record<string, EpgWindowProgramme[]> = {}
    for (const window of windows) {
      for (const source of window.sources) {
        if (seen.has(source.url)) continue
        seen.add(source.url)
        sources.push(source)
      }
      for (const [key, programmes] of Object.entries(window.listings)) {
        // Keys are unique per playlist by construction; a collision would mean the same
        // composite key answered twice, which the mapping cache cannot produce.
        listings[key] = programmes
      }
    }
    return { sources, listings }
  }

  return {
    aggregate,
    /** v0.78.0: every playlist's programmes in one response (primary keys stay bare stream
     *  ids; non-primary keys are `<playlistId>:<streamId>`). */
    aggregatePlaylists,
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
    /** The last computed summary for the primary playlist, if any (no fetch, no recompute). */
    peekMatchSummary(params: { credentials: EpgServiceCredentials }): EpgMatchSummary | null {
      return lastSummary.get(`|${params.credentials.server}|${params.credentials.username}`) ?? null
    },
    /**
     * Drops cached guides so the next request refetches them, then starts those fetches in the
     * background. Pass `url` to refresh a single source — the point of the per-source button: a
     * 168 MB provider guide should not have to come down again to retry one small XMLTV feed.
     */
    /**
     * The picker's data for one stream (v0.76.0): every guide channel the loaded sources carry,
     * the stream's automatic match (what the matcher already decided), the manual override if
     * one is set, and top fuzzy suggestions for a stream the matcher missed. One request feeds
     * the whole mapping UI.
     */
    async mappingPickerData(params: {
      credentials: EpgServiceCredentials
      epgUrls: string[]
      streamId: number
      /** '' (or absent) is the primary playlist — the manual override is stored per playlist. */
      playlistId?: string
    }): Promise<{
      streamName: string
      automatic: { channelId: string; strategy: MatchStrategy; score?: number } | null
      manual: { guideChannelId: string; guideChannelName: string; setAt: number } | null
      suggestions: Array<{ guideChannelId: string; guideChannelName: string; score: number }>
      guideChannels: Array<{ id: string; name: string }>
    }> {
      const { sources, entries, streams } = await resolveEverything({ ...params, playlistId: params.playlistId ?? '' })
      const stream = streams.find((s) => s.stream_id === params.streamId)
      const streamName = stream?.name ?? ''

      let automatic: { channelId: string; strategy: MatchStrategy; score?: number } | null = null
      const suggestions = new Map<string, { name: string; score: number }>()
      const guideChannels: Array<{ id: string; name: string }> = []
      const seen = new Set<string>()
      entries.forEach((entry, i) => {
        const index = ensureIndex(entry)
        if (!entry.guide || !index) return
        if (stream) {
          const result = matchStreamToGuideChannelDetailed(stream, index)
          if (result.channelId && result.strategy) {
            if (!automatic || (result.score ?? 1) > (automatic.score ?? 1)) {
              automatic = { channelId: result.channelId, strategy: result.strategy, score: result.score }
            }
          } else {
            // Nothing qualified: offer the same scoring as suggestions, never applied silently.
            for (const [gid, sig] of index.signatures) {
              const score = tokenSetScore(channelTokens(stream.name), sig.tokens)
              const best = suggestions.get(gid)
              if (!best || score > best.score) {
                suggestions.set(gid, { name: entry.guide.channels.get(gid)?.displayName ?? gid, score })
              }
            }
          }
        }
        for (const [id, channel] of entry.guide.channels) {
          if (seen.has(id)) continue
          seen.add(id)
          guideChannels.push({ id, name: channel.displayName })
        }
      })

      const manual = manualMappings?.get(params.credentials.username, params.playlistId ?? '', params.streamId) ?? null
      return {
        streamName,
        automatic: manual ? null : automatic,
        manual: manual
          ? { guideChannelId: manual.guideChannelId, guideChannelName: manual.guideChannelName, setAt: manual.setAt }
          : null,
        suggestions: [...suggestions.entries()]
          .map(([guideChannelId, s]) => ({ guideChannelId, guideChannelName: s.name, score: s.score }))
          .filter((s) => s.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, 5),
        guideChannels
      }
    },

    refresh(params: { credentials: EpgServiceCredentials; epgUrls: string[]; url?: string }): void {
      const all = [providerGuideUrl(params.credentials), ...params.epgUrls]
      const sources = params.url ? all.filter((url) => url === params.url) : all
      for (const url of sources) {
        guideCache.delete(url)
        // The disk copy has to go too, or the refetch would hydrate the very guide being replaced.
        hydrationBlocked.add(url)
        if (dataDir) void dropCachedGuide(dataDir, url)
      }
      // The mapping was built against every source, so it is rebuilt even for a one-source
      // refresh — it is cheap next to the fetch it is waiting on.
      mappingCache.clear()
      lastSummary.delete(`${params.credentials.server}|${params.credentials.username}`)
      for (const url of sources) void getGuideOrError(url)
    },
    /** Test/ops hook: drop cached guides (channel-list cache keyed to its own shorter TTL). */
    clearGuideCache(): void {
      guideCache.clear()
      mappingCache.clear()
    },
    /**
     * Forgets one source without fetching anything — used when a source is removed, so a restart
     * cannot reload its cached guide and the mapping is rebuilt without it.
     */
    forget(url: string): void {
      guideCache.delete(url)
      hydrationBlocked.add(url)
      mappingCache.clear()
      lastSummary.clear()
    },
    /** The same, for every source at once (the list became empty). */
    forgetAll(): void {
      guideCache.clear()
      mappingCache.clear()
      lastSummary.clear()
    }
  }
}

export type EpgService = ReturnType<typeof createEpgService>

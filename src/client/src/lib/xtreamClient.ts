import type {
  XtreamAuthResponse,
  Category,
  LiveStream,
  VodStream,
  SeriesItem,
  SeriesInfo,
  ShortEpgProgram,
  MediaKind
} from './types'

/**
 * Browser-side Xtream client — a deliberately different shape from the desktop app's own
 * xtream.ts, for one real reason: getStreamUrl()/getTimeshiftUrl() there return the RAW
 * upstream provider URL directly, which works in Electron (no CORS enforcement on that kind
 * of request there) but would not survive a real browser's CORS rules for hls.js's own
 * fetch()-based segment/playlist retrieval — see this project's own EFFORT-ASSESSMENT.md.
 * Every URL this client hands to the player is instead a same-origin relative path
 * (/player_api.php, /live/...), which the server's own relay middleware (src/server/index.ts)
 * recognizes and forwards into the ported proxy — so hls.js never makes a genuinely
 * cross-origin request at all.
 */
export class XtreamClient {
  constructor(
    private readonly username: string,
    private readonly password: string
  ) {}

  private playerApiUrl(params: Record<string, string> = {}): string {
    const url = new URL('/player_api.php', window.location.origin)
    url.searchParams.set('username', this.username)
    url.searchParams.set('password', this.password)
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
    return url.toString()
  }

  private async getJson<T>(url: string): Promise<T> {
    const res = await fetch(url)
    if (!res.ok) throw new Error(`Xtream request failed: ${res.status} ${res.statusText}`)
    return res.json() as Promise<T>
  }

  async authenticate(): Promise<XtreamAuthResponse> {
    const result = await this.getJson<XtreamAuthResponse>(this.playerApiUrl())
    if (!result?.user_info || result.user_info.auth === 0) throw new Error('Invalid Xtream credentials')
    return result
  }

  getLiveCategories(): Promise<Category[]> {
    return this.getJson(this.playerApiUrl({ action: 'get_live_categories' }))
  }

  getLiveStreams(categoryId?: string): Promise<LiveStream[]> {
    const params: Record<string, string> = { action: 'get_live_streams' }
    if (categoryId) params.category_id = categoryId
    return this.getJson(this.playerApiUrl(params))
  }

  getVodCategories(): Promise<Category[]> {
    return this.getJson(this.playerApiUrl({ action: 'get_vod_categories' }))
  }

  getVodStreams(categoryId?: string): Promise<VodStream[]> {
    const params: Record<string, string> = { action: 'get_vod_streams' }
    if (categoryId) params.category_id = categoryId
    return this.getJson(this.playerApiUrl(params))
  }

  getSeriesCategories(): Promise<Category[]> {
    return this.getJson(this.playerApiUrl({ action: 'get_series_categories' }))
  }

  getSeries(categoryId?: string): Promise<SeriesItem[]> {
    const params: Record<string, string> = { action: 'get_series' }
    if (categoryId) params.category_id = categoryId
    return this.getJson(this.playerApiUrl(params))
  }

  getSeriesInfo(seriesId: number): Promise<SeriesInfo> {
    return this.getJson(this.playerApiUrl({ action: 'get_series_info', series_id: String(seriesId) }))
  }

  getShortEpg(streamId: number, limit = 10): Promise<ShortEpgProgram[]> {
    return this.getJson(this.playerApiUrl({ action: 'get_short_epg', stream_id: String(streamId), limit: String(limit) }))
  }

  // Relative, same-origin — see this class's own doc comment for why that's load-bearing here,
  // not just a style choice.
  getStreamUrl(kind: MediaKind, streamId: number, extension: string): string {
    const path = kind === 'live' ? 'live' : kind === 'movie' ? 'movie' : 'series'
    return `/${path}/${this.username}/${this.password}/${streamId}.${extension}`
  }
}

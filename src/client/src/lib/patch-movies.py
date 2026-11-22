import re

p = '/Volumes/AGENT/Development/allison-web-iptv/src/client/src/lib/xtreamClient.ts'
s = open(p).read()

# Add getVodInfo beside getSeriesInfo
anchor = "  getSeriesInfo(seriesId: number): Promise<SeriesInfo> {"
addition = '''  /**
   * The film's own info (v0.118-era get_vod_info passthrough): plot, genre, year, cast and the
   * provider's YouTube trailer id. The list catalogue does not carry these — a per-title call,
   * made when a film starts playing.
   */
  async getVodInfo(vodId: number): Promise<VodInfo> {
    const result = await this.getJson<{ info?: Partial<VodInfo> }>(
      this.playerApiUrl({ action: 'get_vod_info', vod_id: String(vodId) })
    )
    return {
      plot: result.info?.plot ?? '',
      genre: result.info?.genre ?? '',
      releasedate: result.info?.releasedate ?? '',
      cast: result.info?.cast ?? '',
      director: result.info?.director ?? '',
      youtube_trailer: result.info?.youtube_trailer ?? ''
    }
  }

  getSeriesInfo(seriesId: number): Promise<SeriesInfo> {'''
assert anchor in s
s = s.replace(anchor, addition, 1)

# import the type
m = re.search(r"import type \{([^}]*)\} from '\./types'", s)
if m and 'VodInfo' not in m.group(1):
    s = s.replace(m.group(0), "import type { VodInfo, " + m.group(1).strip() + " } from './types'", 1)

open(p, 'w').write(s)

# Add the VodInfo type to types.ts
p2 = '/Volumes/AGENT/Development/allison-web-iptv/src/client/src/lib/types.ts'
s2 = open(p2).read()
if 'export interface VodInfo' not in s2:
    anchor2 = "export interface SeriesItem {"
    addition2 = '''/** The film's own metadata from get_vod_info (v0.119.0) — fields the list catalogue lacks. */
export interface VodInfo {
  plot: string
  genre: string
  releasedate: string
  cast: string
  director: string
  youtube_trailer: string
}

export interface SeriesItem {'''
    assert anchor2 in s2
    s2 = s2.replace(anchor2, addition2, 1)
    open(p2, 'w').write(s2)

print('getVodInfo ok')

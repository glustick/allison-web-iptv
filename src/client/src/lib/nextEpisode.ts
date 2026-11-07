/**
 * What plays after this episode (v0.95.0) — the question a series viewer asks at the credits.
 *
 * Seasons arrive as a map keyed by season number, and the provider's numbering is not trusted to be
 * sorted or contiguous (the Series component already derives the season list from the keys for
 * exactly that reason). So this sorts the season numbers numerically, finds the current episode by
 * id, and falls through to the next season's first episode when the current one is that season's
 * last. No next episode is a real answer: it returns null rather than wrapping to the pilot.
 */
export interface EpisodeLike {
  id: string
  season: number
  episode_num: number
  title: string
}

export function nextEpisode<T extends EpisodeLike>(episodes: Record<string, T[]>, current: { id: string }): T | null {
  const seasonKeys = Object.keys(episodes)
    .map((key) => Number(key))
    .filter((season) => Number.isFinite(season))
    .sort((a, b) => a - b)

  for (let i = 0; i < seasonKeys.length; i += 1) {
    const list = (episodes[String(seasonKeys[i])] ?? []).slice().sort((a, b) => a.episode_num - b.episode_num)
    const index = list.findIndex((episode) => episode.id === current.id)
    if (index === -1) continue
    if (index + 1 < list.length) return list[index + 1]
    for (let j = i + 1; j < seasonKeys.length; j += 1) {
      const following = (episodes[String(seasonKeys[j])] ?? []).slice().sort((a, b) => a.episode_num - b.episode_num)
      if (following.length > 0) return following[0]
    }
    return null
  }
  return null
}

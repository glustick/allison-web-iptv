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

/**
 * Every episode in watch order: seasons numerically (the provider's numbering is neither sorted
 * nor contiguous), and each season's episodes by their own number. The one flattening both
 * functions below share — before v0.99.0 it lived inside nextEpisode, spelled out for one caller.
 */
export function orderedEpisodes<T extends EpisodeLike>(episodes: Record<string, T[]>): T[] {
  const seasonKeys = Object.keys(episodes)
    .map((key) => Number(key))
    .filter((season) => Number.isFinite(season))
    .sort((a, b) => a - b)
  const ordered: T[] = []
  for (const season of seasonKeys) {
    ordered.push(...(episodes[String(season)] ?? []).slice().sort((a, b) => a.episode_num - b.episode_num))
  }
  return ordered
}

export function nextEpisode<T extends EpisodeLike>(episodes: Record<string, T[]>, current: { id: string }): T | null {
  const ordered = orderedEpisodes(episodes)
  const index = ordered.findIndex((episode) => episode.id === current.id)
  if (index === -1) return null
  return ordered[index + 1] ?? null
}

/**
 * Where a viewer actually is in a show (v0.99.0): the first episode they have not marked watched,
 * in watch order. Null when everything is watched — a finished show has nowhere to continue to,
 * and a button that promised otherwise would be lying.
 *
 * Deliberately does not consult resume points: those say where a title was paused, this says
 * which title to open next, and a show with three watched episodes and one half-played one wants
 * the half-played one.
 */
export function firstUnwatchedEpisode<T extends EpisodeLike>(
  episodes: Record<string, T[]>,
  watchedIds: Iterable<string>
): T | null {
  const watched = new Set<string>()
  for (const id of watchedIds) watched.add(String(id))
  return orderedEpisodes(episodes).find((episode) => !watched.has(String(episode.id))) ?? null
}

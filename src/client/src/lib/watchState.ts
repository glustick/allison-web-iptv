import type { MediaKind, WatchedEntry } from './prefs'

/**
 * How a watched record is identified, in one place.
 *
 * The rule is the same one favourites, resume points and the server's table already follow:
 * kind, playlist, stream id — because stream ids are provider-scoped and the same number on two
 * playlists is two different titles. Three call sites (the film list, the episode list, and the
 * player's own "mark once" guard) each spelled this key out before; one function means they
 * cannot drift apart.
 */
export function watchedKey(entry: { kind: MediaKind; playlistId?: string; streamId: number }): string {
  return `${entry.kind}:${entry.playlistId ?? ''}:${entry.streamId}`
}

export function isWatched(
  watched: WatchedEntry[],
  candidate: { kind: MediaKind; playlistId?: string; streamId: number }
): boolean {
  const key = watchedKey(candidate)
  return watched.some((entry) => watchedKey(entry) === key)
}

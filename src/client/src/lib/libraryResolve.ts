/**
 * Library rows point at a channel by the id it had when the row was saved.
 *
 * This provider **renumbers its stream ids** — measured, not assumed: BBC One FHD was 37237 in one
 * week's notes and 42783 in live data the next, and both ids still answer, which is what makes a stale
 * one dangerous. So a favourite saved before a renumbering asks for a stream that no longer exists, and
 * the provider answers with a message like "channel unavailable" — while the same channel plays fine
 * from its category, where the id is current. Reported exactly that way on 2026-09-18.
 *
 * Resolution therefore prefers the provider's own current entry: by id first (the common case, and
 * cheap), then by name — the same channel under a new id. Only when neither matches is the stored
 * row used as-is, which is honest: the channel really has gone.
 *
 * Resolving by name also recovers the fields the library entry never stored, `tv_archive` above all.
 * A synthesised row always claims no archive, so catch-up is silently unavailable for favourites.
 */
import type { LiveStream } from './types'

export interface LibraryEntry {
  streamId: number
  name: string
  category: string | null
}

export interface ProviderLookup {
  byId: Map<number, LiveStream>
  byName: Map<string, LiveStream>
}

export function providerLookup(channels: LiveStream[]): ProviderLookup {
  const byId = new Map<number, LiveStream>()
  const byName = new Map<string, LiveStream>()
  for (const channel of channels) {
    byId.set(channel.stream_id, channel)
    const key = channel.name.trim().toLowerCase()
    // first wins: a provider listing the same name twice should resolve to a stable one
    if (!byName.has(key)) byName.set(key, channel)
  }
  return { byId, byName }
}

/** The provider's current entry for a saved row, or null when it genuinely no longer exists. */
export function resolveLibraryEntry(entry: LibraryEntry, lookup: ProviderLookup): LiveStream | null {
  const byId = lookup.byId.get(entry.streamId)
  if (byId) return byId
  return lookup.byName.get(entry.name.trim().toLowerCase()) ?? null
}

/** True when a saved row still matches a channel the provider lists. */
export function libraryEntryIsStale(entry: LibraryEntry, lookup: ProviderLookup): boolean {
  return resolveLibraryEntry(entry, lookup) === null && (lookup.byId.size > 0 || lookup.byName.size > 0)
}

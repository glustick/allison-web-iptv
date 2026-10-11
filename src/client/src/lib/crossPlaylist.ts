import type { LiveStream } from './types'

// Identity for a live channel across playlists — the key the manual "also on →" switch matches
// on (v0.78.0, the roadmap's phase 3: the operator sees that the other line has the channel and
// switches by hand; nothing merges and nothing fails over on its own, per the 2026-09-23
// decisions).
//
// channelMatchKey is ported code-identical from src/server/lib/playlists.ts (the desktop app's
// own convention for shareable pure modules — see lib/sports.ts): deliberately NOT the stream
// id, because ids are provider-scoped — two profiles use different ids for the same channel and
// the same id for different ones. Normalised name plus category is what a human would match on.
//
// It is a match *heuristic*: a wrong match offers the wrong channel under "also on" (one click,
// visibly labelled, immediately correctable), and a missed match merely offers nothing.

export function channelMatchKey(channel: { name: string; category?: string | null }): string {
  const normalise = (value: string): string =>
    value
      .toLowerCase()
      // Providers prefix the same channel differently on different lines ("UK: Sky Sports Main
      // Event" on one, "Sky Sports Main Event" on another), so a leading region tag is provider
      // furniture rather than part of the name — the first test written for this caught exactly
      // that.
      .replace(/^[a-z]{2,4}\s*:\s*/, '')
      .replace(/\b(uhd|fhd|hd|sd)\b/g, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()
  return `${normalise(channel.name)}|${normalise(channel.category ?? '')}`
}

function normaliseName(value: string): string {
  return value
    .toLowerCase()
    .replace(/^[a-z]{2,4}\s*:\s*/, '')
    .replace(/\b(uhd|fhd|hd|sd)\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

/** One playlist's catalogue as the switch sees it. The primary's id is '' (the prefs convention). */
export interface PlaylistChannels {
  id: string
  label: string
  channels: LiveStream[]
}

export interface AlsoOnMatch {
  playlistId: string
  playlistLabel: string
  /** The matched channel as its own playlist lists it — playing it is the ordinary select path. */
  channel: LiveStream
}

/**
 * Builds the cross-playlist lookup once per catalogue change. The returned function answers for
 * one row: where else this channel lives, excluding the playlist the row belongs to (`ownRef`,
 * '' for the primary). First match per playlist wins — a provider listing the same name twice
 * should resolve to a stable one.
 *
 * Matched on the NORMALISED NAME alone, not the full name+category key: two providers rarely
 * spell a category the same way ("UK | Sports" vs "Sports"), and a category mismatch would
 * silently kill the offer in exactly the messy catalogues this feature exists for. The failure
 * mode of name-only matching is an occasional wrong offer under a visible label — one click,
 * immediately corrected — which beats a switch that is usually absent. The full name+category
 * key stays available (above) for callers that want the stricter join.
 */
export function buildAlsoOnIndex(playlists: PlaylistChannels[]): (channel: { name: string }, ownRef?: string) => AlsoOnMatch[] {
  const index = new Map<string, AlsoOnMatch[]>()
  for (const playlist of playlists) {
    const byName = new Map<string, LiveStream>()
    for (const channel of playlist.channels) {
      const key = normaliseName(channel.name)
      if (!byName.has(key)) byName.set(key, channel)
    }
    for (const [key, channel] of byName) {
      const list = index.get(key) ?? []
      list.push({ playlistId: playlist.id, playlistLabel: playlist.label, channel })
      index.set(key, list)
    }
  }
  return (channel: { name: string }, ownRef?: string): AlsoOnMatch[] =>
    (index.get(normaliseName(channel.name)) ?? []).filter((match) => match.playlistId !== (ownRef ?? ''))
}

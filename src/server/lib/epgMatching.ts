import type { XmltvChannel, XmltvGuide } from './xmltv.js'

// The channel→programme join. The original client-side join was a single exact-string
// epg_channel_id Map.get, which permanently misses every channel whose id is null or formatted
// differently from the guide's own channel ids — in practice the largest bucket of empty EPG
// rows. This module widens that join in deliberate, conservative steps:
//
//   1. exact epg_channel_id match (unchanged behavior, highest trust)
//   2. normalized epg_channel_id match (case/whitespace/formatting differences)
//   3. normalized guide display-name match against the stream's name (recovers channels with no
//      usable id at all; only fires on a *unique* normalized name so two streams can't both
//      silently claim one guide channel)
//
// No fuzzy/substring matching on purpose: a wrong join shows one channel another channel's
// programmes, which is worse than an empty row.

export interface StreamForMatching {
  stream_id: number
  name: string
  epg_channel_id: string | null
}

export interface GuideIndexes {
  /** id exactly as it appears in the guide */
  exactIds: Set<string>
  /** normalized guide channel id → guide channel id */
  byNormalizedId: Map<string, string>
  /** normalized display-name → guide channel ids (may hold several on collisions) */
  byNormalizedDisplayName: Map<string, string[]>
}

const COUNTRY_PREFIX = /^(?:usa?|uk|gb|ca|au)\s*(?:[:|]\s*|\s+)/i
const QUALITY_TOKENS = new Set(['hd', 'sd', 'fhd', 'uhd', '4k', 'hdtv'])

/** Lowercase, de-accented, alphanumeric+space only, whitespace-collapsed. */
export function normalizeName(name: string): string {
  const deaccented = name.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  return deaccented
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

/**
 * Same as normalizeName, plus stripping the decorations that differ between a provider's stream
 * names and a guide's display-names without changing channel identity: leading country/region
 * prefixes ("US: …", "UK | …") and trailing quality markers ("… HD", "… FHD", "… 4K").
 * Parenthesized/bracketed qualifiers ("(Camera 1)", "[backup]") are kept — they usually ARE
 * identity between sibling feeds.
 */
export function normalizeChannelName(name: string): string {
  let working = name.replace(COUNTRY_PREFIX, '')
  const tokens = normalizeName(working).split(' ').filter(Boolean)
  while (tokens.length > 1 && QUALITY_TOKENS.has(tokens[tokens.length - 1])) tokens.pop()
  return tokens.join(' ')
}

export function buildGuideIndexes(guide: XmltvGuide): GuideIndexes {
  const exactIds = new Set<string>(guide.programmesByChannel.keys())
  const byNormalizedId = new Map<string, string>()
  const byNormalizedDisplayName = new Map<string, string[]>()
  for (const channel of guide.channels.values()) {
    if (!guide.programmesByChannel.has(channel.id)) continue
    const normalizedId = normalizeName(channel.id)
    if (normalizedId && !byNormalizedId.has(normalizedId)) {
      byNormalizedId.set(normalizedId, channel.id)
    }
    const normalizedDisplay = normalizeChannelName(channel.displayName)
    if (normalizedDisplay) {
      const existing = byNormalizedDisplayName.get(normalizedDisplay)
      if (existing) {
        if (!existing.includes(channel.id)) existing.push(channel.id)
      } else {
        byNormalizedDisplayName.set(normalizedDisplay, [channel.id])
      }
    }
  }
  return { exactIds, byNormalizedId, byNormalizedDisplayName }
}

/** Resolves one stream to one guide channel id, or null when nothing matches confidently. */
export function matchStreamToGuideChannel(stream: StreamForMatching, indexes: GuideIndexes): string | null {
  if (stream.epg_channel_id) {
    if (indexes.exactIds.has(stream.epg_channel_id)) return stream.epg_channel_id
    const viaNormalizedId = indexes.byNormalizedId.get(normalizeName(stream.epg_channel_id))
    if (viaNormalizedId) return viaNormalizedId
  }
  const viaName = indexes.byNormalizedDisplayName.get(normalizeChannelName(stream.name))
  // Only take a name match when it is unambiguous — a guide with two channels whose normalized
  // display-names collide must not silently feed either stream the other's programmes.
  if (viaName && viaName.length === 1) return viaName[0]
  return null
}

import type { XmltvChannel, XmltvGuide } from './xmltv.js'

// The channel→programme join. The original client-side join was a single exact-string
// epg_channel_id Map.get, which permanently misses every channel whose id is null or formatted
// differently from the guide's own channel ids — in practice the largest bucket of empty EPG
// rows. The join widens in deliberate, ordered steps:
//
//   1. exact epg_channel_id match (highest trust)
//   2. normalized epg_channel_id match (case/whitespace/formatting differences)
//   3. exact normalized display-name match (recovers channels with no usable id at all)
//   4. FUZZY token-set match (v0.6.6) — provider stream names and a third-party guide's
//      display names routinely differ ("Sky Sports 1" vs "Sky Sports One", "Sky News HD" vs
//      "Sky News", "BBC ONE Lon" vs "BBC One London"), and with thousands of channels an exact
//      join leaves most rows empty. Fuzzy is therefore scored, not guessed:
//
//        * candidates come from an inverted token index (a stream only ever scores guide
//          channels sharing a distinctive token) — this is what keeps 3k streams × 6k guide
//          channels fast instead of a full cross-product
//        * score = token-set Dice + first-token/newest-token bonuses − length-mismatch penalty
//        * a match is accepted only when it clears FUZZY_MIN_SCORE *and* beats the runner-up by
//          FUZZY_MIN_MARGIN, so an ambiguous name ("Sky Sports" against "Sky Sports 1" and
//          "Sky Sports 2") yields no match rather than a coin flip that shows one channel
//          another channel's programmes.
//
// Every accepted fuzzy match is reported with its strategy/score so /api/epg/config can show
// what was matched exactly versus fuzzily, and so a mis-join is auditable rather than silent.

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
  /** distinctive token → guide channel ids, the fuzzy candidate index */
  byToken: Map<string, string[]>
  /** guide channel id → its own normalized token set + first token, for scoring */
  signatures: Map<string, { tokens: string[]; first: string }>
}

export type MatchStrategy = 'exact-id' | 'normalized-id' | 'exact-name' | 'fuzzy-name'

export interface MatchResult {
  channelId: string | null
  strategy: MatchStrategy | null
  score?: number
}

const COUNTRY_PREFIX = /^(?:usa?|uk|gb|ca|au)\s*(?:[:|]\s*|\s+)/i
const QUALITY_TOKENS = new Set(['hd', 'sd', 'fhd', 'uhd', '4k', '8k', 'hdtv', 'fhd5', 'sdhd'])

// Tokens that carry no identity in either direction. Deliberately short and conservative: a
// token wrongly dropped here turns into a wrong join somewhere, so this only covers words that
// are pure packaging ("Sky Sports 1 HD" / "Sky Sports One HD TV").
const NOISE_TOKENS = new Set(['tv', 'channel', 'the', 'and', 'plus', 'network', 'feed', 'backup'])

// Number-word folding, applied to both sides so "Sky Sports 1" and "Sky Sports One" agree.
const NUMBER_WORDS: Record<string, string> = {
  one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8',
  nine: '9', ten: '10', eleven: '11', twelve: '12'
}

/** Tokens too common to be useful as fuzzy candidates (every second channel has one). */
const COMMON_TOKEN_CUTOFF = 40

const FUZZY_MIN_SCORE = 0.82
const FUZZY_MIN_MARGIN = 0.06
const MAX_FUZZY_CANDIDATES = 150

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
  const working = name.replace(COUNTRY_PREFIX, '')
  const tokens = normalizeName(working).split(' ').filter(Boolean)
  while (tokens.length > 1 && QUALITY_TOKENS.has(tokens[tokens.length - 1])) tokens.pop()
  return tokens.join(' ')
}

/**
 * The token set used for fuzzy scoring: normalizeChannelName, then drop quality/noise markers
 * wherever they appear and fold number words, so "Sky Sports 1 HD" and "Sky Sports One"
 * collapse to the same set.
 */
export function channelTokens(name: string): string[] {
  const base = normalizeChannelName(name).split(' ').filter(Boolean)
  const tokens: string[] = []
  for (const token of base) {
    if (QUALITY_TOKENS.has(token) || NOISE_TOKENS.has(token)) continue
    tokens.push(NUMBER_WORDS[token] ?? token)
  }
  return tokens
}

// Abbreviations are the single most common provider↔guide difference ("BBC ONE Lon" vs
// "BBC One London"), so a shared prefix counts as a partial match — but never for tokens
// carrying digits, or "Sky Sports 1" could drift onto "Sky Sports 10"/"Sky Sports 11".
const PREFIX_MIN_LEN = 3
const PREFIX_CREDIT = 0.75
const HAS_DIGIT = /\d/

/** Token-set Dice coefficient, with prefix-abbreviation credit: 2·credit / (|A|+|B|). */
function tokenSetScore(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0
  const used = new Array<boolean>(b.length).fill(false)
  let credit = 0
  for (const token of a) {
    let bestIndex = -1
    let bestCredit = 0
    for (let i = 0; i < b.length; i++) {
      if (used[i]) continue
      const candidate = b[i]
      if (candidate === token) {
        bestIndex = i
        bestCredit = 1
        break
      }
      const shorter = token.length <= candidate.length ? token : candidate
      if (
        shorter.length >= PREFIX_MIN_LEN &&
        !HAS_DIGIT.test(shorter) &&
        (candidate.startsWith(token) || token.startsWith(candidate)) &&
        PREFIX_CREDIT > bestCredit
      ) {
        bestIndex = i
        bestCredit = PREFIX_CREDIT
      }
    }
    if (bestIndex >= 0) {
      used[bestIndex] = true
      credit += bestCredit
    }
  }
  return (2 * credit) / (a.length + b.length)
}

export function buildGuideIndexes(guide: XmltvGuide): GuideIndexes {
  const exactIds = new Set<string>(guide.programmesByChannel.keys())
  const byNormalizedId = new Map<string, string>()
  const byNormalizedDisplayName = new Map<string, string[]>()
  const byToken = new Map<string, string[]>()
  const signatures = new Map<string, { tokens: string[]; first: string }>()

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

    const tokens = channelTokens(channel.displayName || channel.id)
    if (tokens.length === 0) continue
    signatures.set(channel.id, { tokens, first: tokens[0] })
    for (const token of new Set(tokens)) {
      const bucket = byToken.get(token)
      if (bucket) {
        if (!bucket.includes(channel.id)) bucket.push(channel.id)
      } else {
        byToken.set(token, [channel.id])
      }
    }
  }

  return { exactIds, byNormalizedId, byNormalizedDisplayName, byToken, signatures }
}

/**
 * Fuzzy lookup via the token index: only guide channels sharing a distinctive token are scored,
 * then the best two scores decide (threshold + margin) so ambiguity produces no match.
 */
function fuzzyMatch(streamTokens: string[], indexes: GuideIndexes): { channelId: string; score: number } | null {
  if (streamTokens.length === 0) return null

  // Candidates: union of the buckets of this stream's distinctive tokens.
  const seen = new Set<string>()
  const candidates: string[] = []
  for (const token of new Set(streamTokens)) {
    const bucket = indexes.byToken.get(token)
    if (!bucket) continue
    if (bucket.length > COMMON_TOKEN_CUTOFF) continue
    for (const id of bucket) {
      if (seen.has(id)) continue
      seen.add(id)
      candidates.push(id)
      if (candidates.length >= MAX_FUZZY_CANDIDATES) break
    }
    if (candidates.length >= MAX_FUZZY_CANDIDATES) break
  }
  if (candidates.length === 0) return null

  let best: { channelId: string; score: number } | null = null
  let runnerUp = 0
  for (const id of candidates) {
    const signature = indexes.signatures.get(id)
    if (!signature) continue
    let score = tokenSetScore(streamTokens, signature.tokens)
    // Same lead token is a real signal for network/region families ("Sky Sports …", "BBC …").
    if (signature.first === streamTokens[0]) score += 0.05
    // Length mismatch penalty: "BBC One" must not beat "BBC One London" for a London stream.
    score -= Math.min(0.1, Math.abs(signature.tokens.length - streamTokens.length) * 0.02)
    if (!best || score > best.score) {
      if (best) runnerUp = best.score
      best = { channelId: id, score }
    } else if (score > runnerUp) {
      runnerUp = score
    }
  }

  if (!best || best.score < FUZZY_MIN_SCORE) return null
  if (best.score - runnerUp < FUZZY_MIN_MARGIN) return null
  return best
}

/** Resolves one stream to one guide channel id, or null when nothing matches confidently. */
export function matchStreamToGuideChannel(stream: StreamForMatching, indexes: GuideIndexes): string | null {
  return matchStreamToGuideChannelDetailed(stream, indexes).channelId
}

/** Same resolution, but reports which step matched and how strongly (for /api/epg/config). */
export function matchStreamToGuideChannelDetailed(stream: StreamForMatching, indexes: GuideIndexes): MatchResult {
  if (stream.epg_channel_id) {
    if (indexes.exactIds.has(stream.epg_channel_id)) {
      return { channelId: stream.epg_channel_id, strategy: 'exact-id' }
    }
    const viaNormalizedId = indexes.byNormalizedId.get(normalizeName(stream.epg_channel_id))
    if (viaNormalizedId) return { channelId: viaNormalizedId, strategy: 'normalized-id' }
  }

  const viaName = indexes.byNormalizedDisplayName.get(normalizeChannelName(stream.name))
  // Only take a name match when it is unambiguous — a guide with two channels whose normalized
  // display-names collide must not silently feed either stream the other's programmes.
  if (viaName && viaName.length === 1) return { channelId: viaName[0], strategy: 'exact-name' }

  const tokens = channelTokens(stream.name)
  const fuzzy = fuzzyMatch(tokens, indexes)
  if (fuzzy) return { channelId: fuzzy.channelId, strategy: 'fuzzy-name', score: fuzzy.score }
  return { channelId: null, strategy: null }
}

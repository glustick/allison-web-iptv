/**
 * The client-side live loop's playlist planner — which segments to fetch, and when to ask again.
 *
 * This is the WebCodecs engine's replacement for the half of hls.js it cannot use: the playlist is
 * still a rolling window whose URLs are re-signed on every refresh (the provider's ~25s signatures,
 * see ROADMAP "Live TV & playback"), so someone has to poll the playlist, notice new segments by
 * absolute sequence number, and fetch them while their signatures are young. hls.js does this for
 * MSE; the canvas player does it with these decisions, made here so they are unit-tested rather
 * than buried in a component.
 *
 * The segment URLs in a snapshot are only valid for that snapshot — the caller fetches what a plan
 * says promptly, and remaps by sequence number (segmentUrlBySequence) when a fetch is refused.
 */

export interface LivePlaylistSegment {
  url: string
  /** From #EXTINF, when the playlist states it — 0 when it does not. */
  durationSec: number
}

export interface LivePlaylist {
  /** #EXT-X-MEDIA-SEQUENCE — the absolute sequence number of the first listed segment. */
  mediaSequence: number
  /** #EXT-X-TARGETDURATION, clamped to at least a second. */
  targetDurationSec: number
  segments: LivePlaylistSegment[]
  /** #EXT-X-ENDLIST — a finished stream, not a live one. */
  ended: boolean
}

/** Null when the text is not an HLS playlist at all (an error body, a raw TS answer). */
export function parseLivePlaylist(text: string): LivePlaylist | null {
  const segments: LivePlaylistSegment[] = []
  let mediaSequence = 0
  let targetDurationSec = 0
  let ended = false
  let sawTag = false
  let pendingDuration: number | null = null
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === '') continue
    if (line.startsWith('#')) {
      sawTag = true
      if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
        const value = Number.parseInt(line.slice('#EXT-X-MEDIA-SEQUENCE:'.length), 10)
        if (Number.isFinite(value)) mediaSequence = value
      } else if (line.startsWith('#EXT-X-TARGETDURATION:')) {
        const value = Number.parseFloat(line.slice('#EXT-X-TARGETDURATION:'.length))
        if (Number.isFinite(value)) targetDurationSec = value
      } else if (line.startsWith('#EXTINF:')) {
        const value = Number.parseFloat(line.slice('#EXTINF:'.length).split(',')[0])
        pendingDuration = Number.isFinite(value) && value > 0 ? value : null
      } else if (line.startsWith('#EXT-X-ENDLIST')) {
        ended = true
      }
      continue
    }
    segments.push({ url: line, durationSec: pendingDuration ?? 0 })
    pendingDuration = null
  }
  // A playlist this app is handed always carries tags (#EXTM3U at minimum); an error body or a raw
  // TS answer does not. Anything without one is not a playlist, whatever its lines look like.
  if (!sawTag) return null
  return { mediaSequence, targetDurationSec: Math.max(1, targetDurationSec), segments, ended }
}

/** How far behind the live edge the loop aims to sit — ~2-3 of this provider's ~4s segments, with headroom for decode. */
export const LIVE_LOOP_LATENCY_SEC = 9

/** Bounded work per poll: a catch-up that fell behind empties over several polls, not in one burst. */
export const MAX_FETCHES_PER_POLL = 12

/**
 * Polls, all caught up, with a playlist that has not advanced — after this many, the loop reports a
 * stagnant playlist rather than waiting forever. Five polls at targetduration cadence is roughly
 * 20s of a channel genuinely broadcasting nothing new.
 */
export const STAGNANT_POLLS = 5

export interface LiveLoopState {
  /** Absolute sequence number of the next segment to fetch — null before the first plan. */
  nextSequence: number | null
  /** Consecutive caught-up polls that saw the same playlist window. */
  stagnantPolls: number
  /** The window the last snapshot showed, for noticing it has not moved. */
  lastWindowKey: string | null
}

export const INITIAL_LIVE_LOOP_STATE: LiveLoopState = { nextSequence: null, stagnantPolls: 0, lastWindowKey: null }

export interface LiveLoopFetch {
  /** The absolute sequence number — the stable identity of this segment across playlist refreshes. */
  sequence: number
  url: string
}

export interface LiveLoopPlan {
  /** Segments to fetch now, oldest first, already bounded by MAX_FETCHES_PER_POLL. */
  fetches: LiveLoopFetch[]
  /** When to poll the playlist again. Short while catching up; playlist cadence when at the edge. */
  nextPollMs: number
  /** True when the loop fell out of the window and rejoined at the latency target — the picture jumps. */
  rejoined: boolean
  /** True when the playlist has stopped advancing — this is a placeholder, not a channel. */
  stagnant: boolean
}

export function planLiveLoop(state: LiveLoopState, playlist: LivePlaylist): { state: LiveLoopState; plan: LiveLoopPlan } {
  const edge = playlist.mediaSequence + playlist.segments.length
  const lastUrl = playlist.segments.length > 0 ? playlist.segments[playlist.segments.length - 1].url : ''
  const windowKey = `${playlist.mediaSequence}:${playlist.segments.length}:${lastUrl}`

  let from = state.nextSequence
  let rejoined = false
  if (from === null || from < playlist.mediaSequence) {
    from = joinSequence(playlist)
    rejoined = state.nextSequence !== null // the first plan is a join, not a re-join
  }

  const fetches: LiveLoopFetch[] = []
  const lastToFetch = Math.min(edge, from + MAX_FETCHES_PER_POLL)
  for (let sequence = from; sequence < lastToFetch; sequence++) {
    const url = segmentUrlBySequence(playlist, sequence)
    if (url === null) break
    fetches.push({ sequence, url })
  }

  const stagnantPolls = windowKey === state.lastWindowKey && fetches.length === 0 ? state.stagnantPolls + 1 : 0
  const caughtUp = from + fetches.length >= edge
  const nextPollMs = caughtUp
    ? Math.min(10_000, Math.max(2_000, playlist.targetDurationSec * 1000))
    : 500

  return {
    state: { nextSequence: from + fetches.length, stagnantPolls, lastWindowKey: windowKey },
    plan: { fetches, nextPollMs, rejoined, stagnant: stagnantPolls >= STAGNANT_POLLS }
  }
}

function joinSequence(playlist: LivePlaylist): number {
  const edge = playlist.mediaSequence + playlist.segments.length
  const average = averageDurationSec(playlist)
  const segmentsBack = Math.max(1, Math.round(LIVE_LOOP_LATENCY_SEC / Math.max(average, 0.5)))
  return Math.max(playlist.mediaSequence, edge - segmentsBack)
}

function averageDurationSec(playlist: LivePlaylist): number {
  const known = playlist.segments.filter((segment) => segment.durationSec > 0)
  if (known.length === 0) return 4 // this provider's segments are ~4s; a guess that only shapes the join point
  return known.reduce((sum, segment) => sum + segment.durationSec, 0) / known.length
}

/** The URL a *fresh* snapshot carries for an absolute sequence number — the refused-segment remap. */
export function segmentUrlBySequence(playlist: LivePlaylist, sequence: number): string | null {
  const index = sequence - playlist.mediaSequence
  return index >= 0 && index < playlist.segments.length ? playlist.segments[index].url : null
}

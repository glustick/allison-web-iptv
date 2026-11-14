// Auto-release at the account's ceiling (v0.107.0). The budget surfaces know the number and
// know WHO holds each connection (v0.85/v0.86/v0.102); until now the picker's answer to "at the
// limit" was a disabled row and an instruction to go hunt for the holding tile. This module is
// the household-honest alternative: when an account is AT its provider-stated limit, decide
// which of ITS OWN tiles to stop so the new one can play — the same most-idle-first logic the
// VOD disk bound proved server-side (v0.103.0), applied to the live budget client-side where
// the tiles are all one grid's to stop.
//
// Deliberate limits, matching the ledger's honesty:
// - only a KNOWN ceiling ever auto-releases (a provider that never stated a number is warned
//   about, never acted against — v0.86.0's rule, unchanged);
// - only tiles of the SAME account are candidates (another account's connections are not this
//   grid's to stop);
// - the audible tile is never the one stopped — sound is the strongest possible signal someone
//   is watching THAT tile, and idleMs already says the rest.

import type { MultiViewSlot } from './multiViewPrefs'

/** The ledger key a tile's stream plays through — the same pathname the relay records. */
export function tileLedgerKey(slot: MultiViewSlot): string {
  return slot.playlistId
    ? `/api/iptv/playlists/${encodeURIComponent(slot.playlistId)}/stream/live/${slot.streamId}.m3u8`
    : `/api/stream/live/${slot.streamId}.m3u8`
}

export interface ReleaseCandidate {
  slotIndex: number
  slot: MultiViewSlot
  /** The ledger's idle reading for this tile's key; null when the ledger has none (a tile that
   *  has not started fetching holds nothing yet, so stopping it frees nothing). */
  idleMs: number | null
  /** Whether this tile is the one making sound. */
  isAudible: boolean
}

export interface AutoReleasePlan {
  /** The slot to clear in the same action that assigns the new channel. */
  slotIndex: number
  /** What the toolbar should say — the viewer must be told which tile went and why. */
  note: string
}

/**
 * Which tile to stop so one more of the same account can play, or null when auto-release does
 * not apply: no known ceiling, not at it, no stoppable tile of that account, or the only
 * candidates are the audible tile / tiles with no ledger presence (stopping those frees
 * nothing — the honest answer is the old blocked row, not a stop that does not help).
 */
export function planAutoRelease(
  candidates: ReleaseCandidate[],
  sameAccountUsage: number,
  knownCeiling: number | null,
  newChannelName: string
): AutoReleasePlan | null {
  if (knownCeiling === null || sameAccountUsage < knownCeiling) return null
  // Eligible: this grid's tiles with a live ledger reading, minus the audible one.
  const eligible = candidates.filter((c) => c.idleMs !== null && !c.isAudible)
  if (eligible.length === 0) return null
  const stoppable = eligible.sort((a, b) => (b.idleMs ?? 0) - (a.idleMs ?? 0) || a.slotIndex - b.slotIndex)
  const victim = stoppable[0]
  return {
    slotIndex: victim.slotIndex,
    note: `“${victim.slot.name}” was stopped — this account is at its ${knownCeiling}-stream limit and that tile was the idlest, so “${newChannelName}” could play.`
  }
}

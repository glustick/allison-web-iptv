/**
 * The client-side player's presentation clock — which decoded frame to draw, and when to give up
 * on one. Pure, so the pacing rules are tested rather than tuned live on a 4K feed.
 *
 * The clock is anchored the moment the first frame is drawn: that frame's PTS *is* "now", and
 * everything after runs off wall time. There is no audio clock yet (audio arrives when this engine
 * joins the player proper), so wall time is the honest master — and a decoder that falls behind is
 * handled the way every live player handles it: late frames are dropped, not queued, and the
 * picture skips forward to the newest frame whose time has come.
 */

import { unwrapPts } from './tsHevc'

/** Presentation timestamps run at MPEG's 90 kHz, per PES. */
export const PTS_HZ = 90_000

/** A decoded frame awaiting its turn. The queue is in presentation order — VideoDecoder emits display order. */
export interface PendingFrame {
  pts: number
}

export interface AppendPtsResult {
  pts: number
  /**
   * True when this timestamp does not belong to the timeline before it — a reset (jumps no small
   * reordering explains). The presenter re-anchors on this frame rather than unwrapping across it.
   */
  discontinuity: boolean
}

// B-frame reordering moves PTS backwards by a few frames between consecutive *decode* submissions;
// a second covers any reorder depth this provider uses. Ten seconds forward is likewise beyond any
// honest gap in a live stream — a jump that size is a new timeline, not elapsed time.
const BACKWARD_JUMP_TICKS = PTS_HZ
const FORWARD_JUMP_TICKS = 10 * PTS_HZ

export function appendPts(previous: number | null, rawPts: number): AppendPtsResult {
  if (previous === null) return { pts: rawPts, discontinuity: false }
  const pts = unwrapPts(rawPts, previous)
  const jump = pts - previous
  return { pts, discontinuity: jump < -BACKWARD_JUMP_TICKS || jump > FORWARD_JUMP_TICKS }
}

/** The presentation clock: the anchor's PTS advanced by wall time since it was drawn. */
export function presenterClockPts(anchorPts: number, anchorWallMs: number, nowMs: number): number {
  return anchorPts + Math.max(0, nowMs - anchorWallMs) * (PTS_HZ / 1000)
}

export interface PresentationChoice {
  /** Index of the frame to draw now — the newest whose time has come. Null when nothing is due. */
  presentIndex: number | null
  /** Frames before this index are older than the one being drawn — close them unshown. */
  dropUntil: number
}

export function choosePresentation(frames: PendingFrame[], clockPts: number): PresentationChoice {
  let due = -1
  for (let i = 0; i < frames.length; i++) {
    if (frames[i].pts <= clockPts) due = i
    else break
  }
  if (due < 0) return { presentIndex: null, dropUntil: 0 }
  return { presentIndex: due, dropUntil: due }
}

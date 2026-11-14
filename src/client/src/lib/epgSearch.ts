// Programme search's client half (v0.108.0). The server filters the aggregated guide by title
// and bounds the answer; this module owns the two decisions the UI should not improvise — how
// far to jump the grid so a found programme is comfortably visible, and how to describe a
// result's time in one honest phrase.

import type { LiveStream } from './types'
import { liveChannelKey } from './types'

export interface EpgSearchResult {
  /** The composite listing key — the same shape liveChannelKey builds. */
  key: string
  programme: { title: string; startMs: number; stopMs: number; description?: string }
}

/**
 * The grid offset that puts a found programme on screen: its start, pulled back by half an hour
 * so an in-progress programme shows the block it lives in rather than starting flush at the
 * left edge. The grid snaps, so this only needs to be approximately right.
 */
export function jumpOffsetFor(programmeStartMs: number, nowMs: number): number {
  return programmeStartMs - nowMs - 30 * 60 * 1000
}

/** "20:00 – 21:00" (or "20:00 – 21:00, tomorrow" when it crosses midnight from now). */
export function describeResultTime(startMs: number, stopMs: number, nowMs: number): string {
  const fmt = (ms: number): string =>
    new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const sameDay = new Date(startMs).toDateString() === new Date(nowMs).toDateString()
  return `${fmt(startMs)} – ${fmt(stopMs)}${sameDay ? '' : ' · ' + new Date(startMs).toLocaleDateString([], { weekday: 'short' })}`
}

/**
 * Resolve a result's key to the channel row the grid can scroll to. The search answer carries
 * only keys; the grid's own `channels` prop is the authority on which of them are on screen.
 */
export function channelForResult(channels: LiveStream[], key: string): LiveStream | null {
  return channels.find((channel) => liveChannelKey(channel) === key) ?? null
}

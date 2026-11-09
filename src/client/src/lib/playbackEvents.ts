/**
 * The player's own recent decisions, kept so a viewer — or whoever they are reporting a freeze to
 * — can see them without opening DevTools (v0.100.0).
 *
 * Every recovery rung already writes a console line: stall detected, loader kicked, source
 * reloaded, session replaced, playlist frozen. Those lines were the only record of *why* a player
 * did what it did, and they lived exclusively in a console nobody had open during a freeze. This is
 * the same record, bounded and readable in the UI.
 *
 * Newest first, because that is what you look at first when something has just gone wrong.
 */
export interface PlaybackEvent {
  /** Local clock time, already formatted — the helper stays free of Date. */
  at: string
  message: string
}

export const PLAYBACK_EVENT_LIMIT = 24

export function appendEvent(
  events: PlaybackEvent[],
  message: string,
  at: string,
  limit = PLAYBACK_EVENT_LIMIT
): PlaybackEvent[] {
  return [{ at, message }, ...events].slice(0, Math.max(0, limit))
}

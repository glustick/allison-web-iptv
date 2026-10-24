/**
 * The multi-view grid's persisted shape: which layout, and which channel each tile holds.
 *
 * Ported from the desktop sibling's Multi-View (its slots live in the store and are deliberately
 * session-only there, because an Electron app's session is the app window); the web sibling
 * persists them **per device** (`localStorage`, the playerPrefs.ts template) because a browser
 * tab surviving a reload should find its tiles where it left them, and a tile set is a statement
 * about *this* screen — the TV in the kitchen wants different tiles from the laptop.
 *
 * A slot carries its own name and playlist id, not a reference into a loaded catalogue: playback
 * only needs the stream id (the relay URL is buildable from it), and the tile can render the
 * name immediately even before — or without — that channel's category ever being loaded.
 */

const KEY = 'iptv:multi-view-prefs'

/** The tile counts the CSS has layouts for — the same closed set the desktop sibling ships. */
export type MultiViewLayout = 2 | 4

export interface MultiViewSlot {
  streamId: number
  name: string
  /** The playlist the channel plays through — '' / undefined = the primary. */
  playlistId?: string
}

export interface MultiViewPrefs {
  layout: MultiViewLayout
  slots: Array<MultiViewSlot | null>
}

export const DEFAULT_MULTI_VIEW_PREFS: MultiViewPrefs = { layout: 2, slots: [null, null] }

/**
 * Grow pads with empty slots, shrink drops the overflow — the desktop store's resize semantics,
 * ported as a pure function so the tile-set arithmetic is testable without a store.
 */
export function resizeSlots(slots: Array<MultiViewSlot | null>, layout: MultiViewLayout): Array<MultiViewSlot | null> {
  if (slots.length === layout) return slots
  if (slots.length > layout) return slots.slice(0, layout)
  return [...slots, ...Array.from({ length: layout - slots.length }, () => null)]
}

/**
 * At most one tile is ever unmuted: clicking the active tile re-mutes it, clicking another moves
 * the audio. Pure, so the one-audio rule is pinned by a test rather than living in a component.
 */
export function toggleActiveAudio(current: number | null, clicked: number): number | null {
  return current === clicked ? null : clicked
}

function parseSlot(value: unknown): MultiViewSlot | null {
  if (typeof value !== 'object' || value === null) return null
  const slot = value as { streamId?: unknown; name?: unknown; playlistId?: unknown }
  if (typeof slot.streamId !== 'number' || !Number.isFinite(slot.streamId) || slot.streamId <= 0) return null
  if (typeof slot.name !== 'string' || slot.name.length === 0) return null
  return {
    streamId: slot.streamId,
    name: slot.name,
    playlistId: typeof slot.playlistId === 'string' && slot.playlistId.length > 0 ? slot.playlistId : undefined
  }
}

export function loadMultiViewPrefs(storage: Pick<Storage, 'getItem'> | null = safeStorage()): MultiViewPrefs {
  if (!storage) return DEFAULT_MULTI_VIEW_PREFS
  try {
    const raw = storage.getItem(KEY)
    if (!raw) return DEFAULT_MULTI_VIEW_PREFS
    const parsed = JSON.parse(raw) as { layout?: unknown; slots?: unknown }
    const layout: MultiViewLayout = parsed.layout === 4 ? 4 : 2
    if (!Array.isArray(parsed.slots)) return { layout, slots: resizeSlots([], layout) }
    return { layout, slots: resizeSlots(parsed.slots.map(parseSlot), layout) }
  } catch {
    return DEFAULT_MULTI_VIEW_PREFS
  }
}

export function saveMultiViewPrefs(
  prefs: MultiViewPrefs,
  storage: Pick<Storage, 'setItem'> | null = safeStorage()
): void {
  if (!storage) return
  try {
    storage.setItem(KEY, JSON.stringify(prefs))
  } catch {
    // A full or unavailable store is not worth failing the grid over.
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

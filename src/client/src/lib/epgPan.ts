// Drag-to-pan math for the EPG timeline, kept pure so it is directly unit-testable
// (the same arrangement as lib/epgTime.ts).
//
// The grid shows a fixed-width time window (WINDOW_HOURS in EpgGrid.tsx) positioned by an offset
// from the current hour. Dragging the timeline should slide that window: grabbing the guide and
// pulling it right reveals *earlier* programmes, exactly like dragging a paper timetable. The
// existing ◀ / Now / ▶ buttons keep working and stay relative to wherever a drag left the window.

/** How far a drag must travel before it counts as a pan rather than a click on a programme. */
export const EPG_PAN_DRAG_THRESHOLD_PX = 4

/** Window offset snap, so a pan lands on :00/:15/:30/:45 rather than an arbitrary second. */
export const EPG_PAN_SNAP_MS = 15 * 60 * 1000

export function snapOffset(offsetMs: number, snapMs: number = EPG_PAN_SNAP_MS): number {
  if (!Number.isFinite(offsetMs) || snapMs <= 0) return 0
  const snapped = Math.round(offsetMs / snapMs) * snapMs
  // Math.round() produces -0 for small negative offsets, which then leaks through arithmetic and
  // makes otherwise-equal values compare as different (Object.is(-0, 0) is false).
  return snapped === 0 ? 0 : snapped
}

/**
 * The window offset after dragging from `startX` to `x` across a `trackWidthPx`-wide timeline
 * showing `windowMs` of guide. Pointer movement is converted with the timeline's own scale, so
 * the guide tracks the pointer 1:1 at any column width.
 */
export function windowOffsetAfterDrag(
  startOffsetMs: number,
  startX: number,
  x: number,
  trackWidthPx: number,
  windowMs: number,
  snapMs: number = EPG_PAN_SNAP_MS
): number {
  if (!Number.isFinite(trackWidthPx) || trackWidthPx <= 0 || !Number.isFinite(windowMs) || windowMs <= 0) {
    return snapOffset(startOffsetMs, snapMs)
  }
  const msPerPx = windowMs / trackWidthPx
  // Negative delta (dragging left) moves the window later — towards future programmes.
  return snapOffset(startOffsetMs - (x - startX) * msPerPx, snapMs)
}

/**
 * Whether pointer movement counts as a pan. Horizontal intent only: a mostly-vertical drag over
 * the guide belongs to the channel list's own scrolling, and treating it as a pan would also
 * swallow the click that follows it.
 */
export function isTimelineDrag(
  startX: number,
  startY: number,
  x: number,
  y: number,
  thresholdPx: number = EPG_PAN_DRAG_THRESHOLD_PX
): boolean {
  const dx = x - startX
  const dy = y - startY
  return Math.abs(dx) >= thresholdPx && Math.abs(dx) > Math.abs(dy)
}

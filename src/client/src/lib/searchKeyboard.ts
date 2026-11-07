/**
 * Arrow keys through a search result list (v0.94.0).
 *
 * Clamped rather than wrapping: pressing Down at the last result should stay there, because a list
 * that jumps back to the top makes Enter unpredictable.
 */
export function nextHighlight(current: number, delta: number, length: number): number {
  if (length <= 0) return -1
  if (current < 0) return delta > 0 ? 0 : length - 1
  return Math.min(length - 1, Math.max(0, current + delta))
}

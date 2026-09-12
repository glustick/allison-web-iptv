import { loadSavedDimension, saveDimension, useResizableDimension } from './useResizableDimension.js'

// The category sidebar's drag-resizable width — the same arrangement the desktop app's own
// Sidebar has used since v0.7.9 (min 160 / max 320 there; a little wider max here since the
// web app's category names carry longer "USA | ..." prefixes). Instantiated per view
// (LiveTv/Movies/Series); only one renders at a time, and all reads and commits go through the
// same localStorage key, so they stay in sync without lifting state.
const SIDEBAR_WIDTH_KEY = 'sidebar-width'
const SIDEBAR_MIN_WIDTH = 160
const SIDEBAR_MAX_WIDTH = 360
const SIDEBAR_DEFAULT_WIDTH = 220

export function useSidebarWidth(): { sidebarWidth: number; startSidebarDrag: (e: React.PointerEvent) => void } {
  const { dimension, startDrag } = useResizableDimension(
    loadSavedDimension(SIDEBAR_WIDTH_KEY, SIDEBAR_DEFAULT_WIDTH, SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH),
    'x',
    {
      min: SIDEBAR_MIN_WIDTH,
      max: SIDEBAR_MAX_WIDTH,
      onCommit: (w) => saveDimension(SIDEBAR_WIDTH_KEY, w)
    }
  )
  return { sidebarWidth: dimension, startSidebarDrag: startDrag }
}

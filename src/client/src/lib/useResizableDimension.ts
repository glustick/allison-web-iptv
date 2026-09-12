import { useCallback, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'

// Drag-to-resize machinery, ported from the desktop app's own lib/useResizableWidth.ts (its
// v0.7.9 drag-resizable EPG channel column) and generalized to both axes with pointer events
// so touch works too. Same shape as there: `dimension` state updates live during the drag
// (rendering tracks the pointer), a ref mirrors it so the window listeners always read fresh
// values without re-binding, and `onCommit` fires exactly once on release — the place to
// persist, not on every move.

/** Pure clamp so the drag math is directly testable without a DOM. */
export function nextDimension(startDimension: number, deltaPx: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, startDimension + deltaPx))
}

/**
 * Reads a saved panel dimension from localStorage, re-clamped to [min, max] so a stale value
 * from a different screen or an older layout can't produce an unusable panel. Returns the
 * fallback for anything missing, non-numeric, or out of range.
 */
export function loadSavedDimension(key: string, fallback: number, min: number, max: number): number {
  try {
    const raw = window.localStorage.getItem(key)
    if (raw === null) return fallback
    const parsed = Number(raw)
    if (!Number.isFinite(parsed)) return fallback
    return nextDimension(parsed, 0, min, max)
  } catch {
    // Private-browsing-style environments can throw on localStorage access — a panel width is
    // not worth failing a render over.
    return fallback
  }
}

export function saveDimension(key: string, value: number): void {
  try {
    window.localStorage.setItem(key, String(value))
  } catch {
    // See loadSavedDimension.
  }
}

export interface ResizableDimensionOptions {
  min: number
  max: number
  onCommit?: (dimension: number) => void
}

export function useResizableDimension(
  initialDimension: number,
  axis: 'x' | 'y',
  opts: ResizableDimensionOptions
): { dimension: number; startDrag: (e: ReactPointerEvent) => void } {
  const [dimension, setDimension] = useState(initialDimension)
  const dimensionRef = useRef(initialDimension)
  const { min, max, onCommit } = opts
  const onCommitRef = useRef(onCommit)
  onCommitRef.current = onCommit

  const startDrag = useCallback(
    (e: ReactPointerEvent) => {
      e.preventDefault()
      const startPx = axis === 'x' ? e.clientX : e.clientY
      const startDimension = dimensionRef.current
      // Applied to <body> for the whole drag: keeps the resize cursor everywhere (the pointer
      // inevitably outruns the 8px handle) and suppresses text selection mid-drag.
      const dragClass = axis === 'x' ? 'resizing-col' : 'resizing-row'

      const onPointerMove = (ev: PointerEvent): void => {
        const currentPx = axis === 'x' ? ev.clientX : ev.clientY
        const next = nextDimension(startDimension, currentPx - startPx, min, max)
        dimensionRef.current = next
        setDimension(next)
      }
      const onPointerUp = (): void => {
        window.removeEventListener('pointermove', onPointerMove)
        window.removeEventListener('pointerup', onPointerUp)
        window.removeEventListener('pointercancel', onPointerUp)
        document.body.classList.remove(dragClass)
        onCommitRef.current?.(dimensionRef.current)
      }
      document.body.classList.add(dragClass)
      window.addEventListener('pointermove', onPointerMove)
      window.addEventListener('pointerup', onPointerUp)
      window.addEventListener('pointercancel', onPointerUp)
    },
    [axis, min, max]
  )

  return { dimension, startDrag }
}

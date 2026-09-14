import { useCallback, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { nextDimension } from './useResizableDimension'

// Drag-to-resize table columns for the main panels (Admin console, EPG section), sharing the
// pointer-event and persistence primitives the rest of the app already uses for its panels
// (useResizableDimension.ts): live state during the drag, commit-once on release, localStorage
// per table. Widths are pixel values applied to a `table-layout: fixed` table, and the panel's
// text scales with the total width so widening the columns also makes the content readable
// instead of leaving a wider gap around the same size text.

export interface ColumnSpec {
  key: string
  /** Header text (the hook itself doesn't render it; the panel maps its columns to <th>s). */
  label?: string
  /** Starting width in pixels; also the reference for the font scale. */
  defaultWidth: number
  min: number
  max: number
}

/** Font scaling is deliberately gentle: it should follow the drag, not fight the user's zoom. */
export const MIN_FONT_SCALE = 0.85
export const MAX_FONT_SCALE = 1.4

/** Pure: how much to scale the panel text for a set of column widths. */
export function columnFontScale(totalWidth: number, defaultTotal: number, min = MIN_FONT_SCALE, max = MAX_FONT_SCALE): number {
  if (!Number.isFinite(totalWidth) || !Number.isFinite(defaultTotal) || defaultTotal <= 0) return 1
  const ratio = totalWidth / defaultTotal
  return Math.round(Math.min(max, Math.max(min, ratio)) * 100) / 100
}

export function totalWidth(widths: Record<string, number>): number {
  return Object.values(widths).reduce((sum, width) => sum + (Number.isFinite(width) ? width : 0), 0)
}

export function defaultWidths(columns: ColumnSpec[]): Record<string, number> {
  return Object.fromEntries(columns.map((column) => [column.key, column.defaultWidth]))
}

/**
 * Column widths as percentages of their own total. Rendering the pixel widths directly would
 * make the table wider than its panel (columns sum past the viewport, so it scrolls sideways);
 * proportions keep the table fitting at any panel width while a drag still changes the relative
 * sizes — and the font scale below still follows the underlying pixel total, so widening a
 * column visibly enlarges the text.
 */
export function percentWidths(widths: Record<string, number>): Record<string, number> {
  const total = totalWidth(widths)
  if (!Number.isFinite(total) || total <= 0) return widths
  return Object.fromEntries(
    Object.entries(widths).map(([key, width]) => [key, (width / total) * 100])
  )
}

export function localStorageKey(tableKey: string): string {
  return `allison-web-iptv:cols:${tableKey}`
}

/** Saved widths, each re-clamped (and unknown keys dropped) so a stale or edited value can't
 *  produce an unusable column. */
export function loadSavedWidths(tableKey: string, columns: ColumnSpec[]): Record<string, number> {
  const fallback = defaultWidths(columns)
  try {
    const raw = window.localStorage.getItem(localStorageKey(tableKey))
    if (raw === null) return fallback
    const parsed = JSON.parse(raw) as Record<string, unknown>
    for (const column of columns) {
      const value = Number(parsed?.[column.key])
      if (Number.isFinite(value)) fallback[column.key] = nextDimension(value, 0, column.min, column.max)
    }
    return fallback
  } catch {
    // Missing/corrupt/permission-denied storage is not worth failing a render over.
    return fallback
  }
}

export function saveWidths(tableKey: string, widths: Record<string, number>): void {
  try {
    window.localStorage.setItem(localStorageKey(tableKey), JSON.stringify(widths))
  } catch {
    // See loadSavedWidths.
  }
}

export interface ResizableColumns {
  widths: Record<string, number>
  /** The same widths as percentages of their total — what the <th> styles actually use. */
  percent: Record<string, number>
  /** Font scale for the panel, derived from the current total width. */
  fontScale: number
  /** Pointer-down handler for a column's resize handle. */
  startDrag: (key: string) => (event: ReactPointerEvent) => void
  /** Restores one column (or all, with no key) to its default width. */
  reset: (key?: string) => void
}

export function useResizableColumns(tableKey: string, columns: ColumnSpec[]): ResizableColumns {
  const initial = ((): Record<string, number> => {
    // Read straight from storage on first render: this runs in the browser (these panels are
    // client-only), and doing it here avoids a visible reflow from defaults to saved widths.
    const saved = loadSavedWidths(tableKey, columns)
    return saved
  })()
  const [widths, setWidths] = useState<Record<string, number>>(initial)
  const widthsRef = useRef(widths)
  widthsRef.current = widths
  const columnsRef = useRef(columns)
  columnsRef.current = columns
  const tableKeyRef = useRef(tableKey)
  tableKeyRef.current = tableKey

  const startDrag = useCallback((key: string): ((event: ReactPointerEvent) => void) => {
    return (event: ReactPointerEvent): void => {
      event.preventDefault()
      event.stopPropagation()
      const column = columnsRef.current.find((entry) => entry.key === key)
      if (!column) return
      const startPx = event.clientX
      const startWidth = widthsRef.current[key] ?? column.defaultWidth

      const onPointerMove = (ev: PointerEvent): void => {
        const next = nextDimension(startWidth, ev.clientX - startPx, column.min, column.max)
        setWidths((current) => {
          const updated = { ...current, [key]: next }
          widthsRef.current = updated
          return updated
        })
      }
      const onPointerUp = (): void => {
        window.removeEventListener('pointermove', onPointerMove)
        window.removeEventListener('pointerup', onPointerUp)
        window.removeEventListener('pointercancel', onPointerUp)
        document.body.classList.remove('resizing-col')
        saveWidths(tableKeyRef.current, widthsRef.current)
      }
      document.body.classList.add('resizing-col')
      window.addEventListener('pointermove', onPointerMove)
      window.addEventListener('pointerup', onPointerUp)
      window.addEventListener('pointercancel', onPointerUp)
    }
  }, [])

  const reset = useCallback((key?: string): void => {
    setWidths((current) => {
      const defaults = defaultWidths(columnsRef.current)
      const updated = key === undefined ? defaults : { ...current, [key]: defaults[key] ?? current[key] }
      widthsRef.current = updated
      saveWidths(tableKeyRef.current, updated)
      return updated
    })
  }, [])

  return {
    widths,
    percent: percentWidths(widths),
    fontScale: columnFontScale(totalWidth(widths), totalWidth(defaultWidths(columns))),
    startDrag,
    reset
  }
}

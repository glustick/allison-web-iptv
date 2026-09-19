import { useState, type JSX, type ReactNode } from 'react'

// Library lists (favourites, custom categories) are short and personal, so unlike the 27k-channel
// guide they get a plain list with real drag-and-drop instead of the virtualised grid.
//
// The reorder mechanics deliberately exist twice: pointer drag for a mouse, and ▲/▼ buttons for
// keyboard, touch and anyone who can't drag. Both commit through the same handler, and the
// buttons are also what makes the feature testable without synthesising drag events.

export interface ReorderableRow {
  /** Stable identity for React and for the reorder payload. */
  key: string
  streamId: number
  /**
   * The id the *saved entry* uses, when it differs from the channel's current one.
   *
   * This provider renumbers stream ids, so a favourite can point at an id the provider no longer lists
   * while the channel itself still resolves — by name. Playback wants the resolved id; reordering and
   * removing want the id the entry is actually stored under, because those are matched against the saved
   * list. Carrying only the resolved one made both silently do nothing.
   */
  storedStreamId?: number
  name: string
  kind: 'live' | 'movie' | 'series'
  /** Channel artwork, when the entry (or a loaded channel list) has it. */
  icon?: string | null
  /** Optional trailing note (a resume point, a status). */
  badge?: string
}

export function ReorderableChannelList({
  rows,
  reorderable,
  activeKey,
  emptyMessage,
  onPlay,
  onReorder,
  rowActions
}: {
  rows: ReorderableRow[]
  /** History is time-ordered, so reordering is offered only where it means something. */
  reorderable: boolean
  activeKey?: string
  emptyMessage?: string
  onPlay: (row: ReorderableRow) => void
  onReorder?: (ordered: ReorderableRow[]) => void
  rowActions?: (row: ReorderableRow) => ReactNode
}): JSX.Element {
  const [dragKey, setDragKey] = useState<string | null>(null)
  const [overKey, setOverKey] = useState<string | null>(null)

  function commit(ordered: ReorderableRow[]): void {
    onReorder?.(ordered)
  }

  function moveBy(row: ReorderableRow, delta: number): void {
    const index = rows.findIndex((entry) => entry.key === row.key)
    const target = index + delta
    if (index < 0 || target < 0 || target >= rows.length) return
    const next = [...rows]
    const [moved] = next.splice(index, 1)
    next.splice(target, 0, moved)
    commit(next)
  }

  function handleDrop(target: ReorderableRow): void {
    setOverKey(null)
    if (dragKey === null || dragKey === target.key) return
    const from = rows.findIndex((entry) => entry.key === dragKey)
    const to = rows.findIndex((entry) => entry.key === target.key)
    if (from < 0 || to < 0) return
    const next = [...rows]
    const [moved] = next.splice(from, 1)
    next.splice(to, 0, moved)
    commit(next)
  }

  if (rows.length === 0) {
    return <p className="list-hint">{emptyMessage ?? 'Nothing here yet.'}</p>
  }

  return (
    <ul className="reorder-list">
      {rows.map((row, index) => (
        <li
          key={row.key}
          className={`reorder-row${activeKey === row.key ? ' active' : ''}${overKey === row.key ? ' drag-over' : ''}`}
          draggable={reorderable}
          onDragStart={() => setDragKey(row.key)}
          onDragEnd={() => {
            setDragKey(null)
            setOverKey(null)
          }}
          onDragOver={(event) => {
            if (!reorderable) return
            event.preventDefault()
            setOverKey(row.key)
          }}
          onDrop={(event) => {
            if (!reorderable) return
            event.preventDefault()
            handleDrop(row)
          }}
        >
          {reorderable && (
            <span className="reorder-grip" title="Drag to reorder" aria-hidden="true">
              ⋮⋮
            </span>
          )}
          <button type="button" className="reorder-name" onClick={() => onPlay(row)}>
            {row.icon ? (
              <img className="reorder-icon" src={row.icon} alt="" loading="lazy" />
            ) : (
              <span className="reorder-icon placeholder" aria-hidden="true" />
            )}
            <span className="reorder-label">{row.name}</span>
            {row.badge && <span className="resume-badge">{row.badge}</span>}
          </button>
          {rowActions?.(row)}
          {reorderable && (
            <span className="reorder-buttons">
              <button
                type="button"
                className="admin-small-btn"
                aria-label={`Move ${row.name} up`}
                title="Move up"
                disabled={index === 0}
                onClick={() => moveBy(row, -1)}
              >
                ▲
              </button>
              <button
                type="button"
                className="admin-small-btn"
                aria-label={`Move ${row.name} down`}
                title="Move down"
                disabled={index === rows.length - 1}
                onClick={() => moveBy(row, 1)}
              >
                ▼
              </button>
            </span>
          )}
        </li>
      ))}
    </ul>
  )
}

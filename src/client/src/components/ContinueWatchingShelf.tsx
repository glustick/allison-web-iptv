import type { JSX } from 'react'
import { progressPercent, formatDuration } from '../lib/continueWatching'

export interface ContinueItem {
  key: string
  name: string
  positionSeconds: number
  durationSeconds: number | null
  playlistLabel?: string
}

/**
 * The shelf of half-watched films (v0.92.0) — the question "what was I watching?" answered
 * without opening the history view first.
 *
 * Each card is a button plus a **sibling** dismiss: nesting the × inside the resume button would
 * make one click mean two things, which is the same reason the guide's reminder bell is a sibling
 * of its programme block.
 */
export function ContinueWatchingShelf<T extends ContinueItem>({
  items,
  onResume,
  onDismiss
}: {
  items: T[]
  onResume: (item: T) => void
  onDismiss: (item: T) => void
}): JSX.Element | null {
  if (items.length === 0) return null
  return (
    <div className="cw-shelf">
      <div className="cw-heading">Continue watching</div>
      <div className="cw-row">
        {items.map((item) => {
          const percent = progressPercent(item.positionSeconds, item.durationSeconds)
          return (
            <div className="cw-card" key={item.key}>
              <button type="button" className="cw-open" onClick={() => onResume(item)} title={`Resume ${item.name}`}>
                <span className="cw-name">{item.name}</span>
                <span className="cw-bar">
                  <span className="cw-bar-fill" style={{ width: `${percent ?? 0}%` }} />
                </span>
                <span className="cw-meta">
                  {percent === null ? `Resume at ${formatDuration(item.positionSeconds)}` : `${percent}% · ${formatDuration(item.positionSeconds)}`}
                  {item.playlistLabel ? ` · ${item.playlistLabel}` : ''}
                </span>
              </button>
              <button
                type="button"
                className="cw-dismiss"
                aria-label={`Remove ${item.name} from continue watching`}
                title="Remove from continue watching"
                onClick={() => onDismiss(item)}
              >
                ×
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}

import type { JSX } from 'react'

/**
 * A filter box for a list that is already loaded (v0.94.0).
 *
 * Deliberately not the global search: that one asks the server and covers the whole catalogue,
 * while this narrows what is on screen without a request and without leaving the view. It says how
 * many rows survive, because a filter that hides everything must not look like an empty list.
 */
export function ListFilter({
  value,
  onChange,
  placeholder,
  shown,
  total
}: {
  value: string
  onChange: (value: string) => void
  placeholder: string
  shown?: number
  total?: number
}): JSX.Element {
  return (
    <div className="list-filter">
      <input
        type="search"
        className="list-filter-input"
        value={value}
        placeholder={placeholder}
        aria-label={placeholder}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') onChange('')
        }}
      />
      {value.trim() && (
        <>
          {typeof shown === 'number' && typeof total === 'number' && (
            <span className="list-filter-count">
              {shown} of {total}
            </span>
          )}
          <button type="button" className="admin-small-btn" onClick={() => onChange('')}>
            Clear
          </button>
        </>
      )}
    </div>
  )
}

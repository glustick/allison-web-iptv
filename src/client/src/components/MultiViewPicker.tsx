import { useEffect, useMemo, useState, type JSX } from 'react'
import type { XtreamClient } from '../lib/xtreamClient'
import type { Category, LiveStream } from '../lib/types'
import type { MultiViewSlot } from '../lib/multiViewPrefs'
import {
  CONNECTION_CEILING,
  accountTileUsage,
  tileGate,
  tileWouldExceed,
  type ConnectionSnapshot,
  type PlaylistLimits
} from '../lib/connectionBudget'

/**
 * The multi-view tile picker — the desktop sibling's picker re-cut for this app's shapes.
 * Favourites open first (instant, already in memory, and the operator's own words made them
 * first: "favourites list first, then prepopulating the category selection"); the category
 * dropdown covers the primary's categories (fetched on demand, one category at a time — never
 * a bulk load of the 12k-channel catalogue) and every additional playlist's full channel list,
 * which LiveTv already holds in memory. One click assigns the channel to the pending tile.
 */

export interface MultiViewPickerProps {
  slotIndex: number
  client: XtreamClient
  categories: Category[]
  favourites: Array<{ streamId: number; name: string; playlistId?: string }>
  playlists: Array<{ id: string; label: string; channels: LiveStream[] }>
  /** The live connection count (null while unknown) — gates the add-at-the-ceiling warning. */
  connections: ConnectionSnapshot | null
  /** Per-account provider limits ('' = primary, v0.86.0): a KNOWN limit blocks rows of an
   *  account already at it; unknown accounts keep the warn-only behaviour. */
  limits: PlaylistLimits
  /** The current tile set — an account's own tiles are the connections it is holding. */
  slots: Array<MultiViewSlot | null>
  onAssign: (slot: MultiViewSlot) => void
  onClose: () => void
}

/** How many filtered rows a scope may show before asking for a narrower filter. */
const MAX_ROWS = 200

interface PickerRow {
  key: string
  streamId: number
  name: string
  playlistId?: string
  playlistLabel?: string
  icon: string
}

export function MultiViewPicker({
  slotIndex,
  client,
  categories,
  favourites,
  playlists,
  connections,
  limits,
  slots,
  onAssign,
  onClose
}: MultiViewPickerProps): JSX.Element {
  const [scope, setScope] = useState('fav')
  const [filter, setFilter] = useState('')
  const [fetched, setFetched] = useState<Record<string, LiveStream[]>>({})
  const [fetchError, setFetchError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  // Fetch a primary-side scope (a category, or all channels) the first time it is selected —
  // playlist scopes and favourites never fetch; their rows arrive as props.
  useEffect(() => {
    if (!scope.startsWith('cat:') && scope !== 'all') return
    if (fetched[scope]) return
    let active = true
    setLoading(true)
    setFetchError(null)
    const categoryId = scope.startsWith('cat:') ? scope.slice(4) : undefined
    client
      .getLiveStreams(categoryId)
      .then((channels) => {
        if (active) setFetched((prev) => ({ ...prev, [scope]: channels }))
      })
      .catch((err) => {
        if (active) setFetchError(err instanceof Error ? err.message : 'Failed to load channels')
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [scope, fetched, client])

  const rows = useMemo<PickerRow[]>(() => {
    const term = filter.trim().toLowerCase()
    let all: PickerRow[] = []
    if (scope === 'fav') {
      all = favourites.map((favourite) => ({
        key: `fav:${favourite.playlistId ?? ''}:${favourite.streamId}`,
        streamId: favourite.streamId,
        name: favourite.name,
        playlistId: favourite.playlistId,
        playlistLabel: favourite.playlistId ? playlists.find((p) => p.id === favourite.playlistId)?.label : undefined,
        icon: ''
      }))
    } else if (scope.startsWith('pl:')) {
      const playlist = playlists.find((p) => p.id === scope.slice(3))
      all = (playlist?.channels ?? []).map((channel) => ({
        key: `pl:${playlist?.id}:${channel.stream_id}`,
        streamId: channel.stream_id,
        name: channel.name,
        playlistId: playlist?.id,
        playlistLabel: playlist?.label,
        icon: channel.stream_icon
      }))
    } else {
      const channels = fetched[scope] ?? []
      all = channels.map((channel) => ({
        key: `primary:${channel.stream_id}`,
        streamId: channel.stream_id,
        name: channel.name,
        icon: channel.stream_icon
      }))
    }
    return term ? all.filter((row) => row.name.toLowerCase().includes(term)) : all
  }, [scope, filter, favourites, playlists, fetched])

  return (
    <div className="multiview-picker-overlay" onClick={onClose}>
      <div className="multiview-picker" onClick={(event) => event.stopPropagation()}>
        <div className="multiview-picker-head">
          <strong>Tile {slotIndex + 1}</strong>
          <input
            className="multiview-picker-filter"
            type="search"
            placeholder="Filter by name…"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            autoFocus
          />
          <button type="button" className="admin-small-btn" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="multiview-picker-scopes">
          <select value={scope} onChange={(event) => setScope(event.target.value)}>
            <option value="fav">★ Favourites ({favourites.length})</option>
            <option value="all">Main — all channels</option>
            {categories.map((category) => (
              <option key={category.category_id} value={`cat:${category.category_id}`}>
                {category.category_name}
              </option>
            ))}
            {playlists.map((playlist) => (
              <option key={playlist.id} value={`pl:${playlist.id}`}>
                {playlist.label} ({playlist.channels.length})
              </option>
            ))}
          </select>
        </div>
        {tileWouldExceed(connections) && (
          <div className="epg-note">
            ⚠ {connections?.used ?? CONNECTION_CEILING} live connections in use — the provider allows about{' '}
            {CONNECTION_CEILING}. Adding this tile may starve it, or starve the others; the main player stays the
            safe surface.
          </div>
        )}
        <div className="multiview-picker-list">
          {loading && <div className="epg-note">Loading channels…</div>}
          {fetchError && <div className="login-error">{fetchError}</div>}
          {!loading && !fetchError && rows.length === 0 && (
            <div className="epg-note">
              {favourites.length === 0 && scope === 'fav'
                ? 'No favourites yet — press ☆ on a channel while it plays, or pick a category above.'
                : 'No channels match the filter.'}
            </div>
          )}
          {rows.slice(0, MAX_ROWS).map((row) => {
            // Judged against the row's OWN account: its tiles so far vs its provider limit.
            const accountKey = row.playlistId ?? ''
            const gate = tileGate(accountTileUsage(slots, accountKey), limits[accountKey] ?? null, connections)
            const blocked = gate === 'block'
            return (
            <button
              type="button"
              key={row.key}
              className={`multiview-picker-row${blocked ? ' multiview-picker-row--blocked' : ''}`}
              disabled={blocked}
              title={
                blocked
                  ? `This account already holds ${accountTileUsage(slots, accountKey)} of its ${limits[accountKey]} allowed connections — remove one of its tiles first.`
                  : undefined
              }
              onClick={() =>
                onAssign({ streamId: row.streamId, name: row.name, playlistId: row.playlistId })
              }
            >
              <span className="multiview-picker-name">
                {row.icon ? <img src={row.icon} alt="" loading="lazy" /> : null}
                {row.name}
              </span>
              {row.playlistLabel ? <span className="multiview-picker-badge">{row.playlistLabel}</span> : null}
              {blocked ? <span className="multiview-picker-badge">at limit</span> : null}
            </button>
            )
          })}
          {rows.length > MAX_ROWS && (
            <div className="epg-note">Showing {MAX_ROWS} of {rows.length} — keep typing to narrow it down.</div>
          )}
        </div>
      </div>
    </div>
  )
}

import { useCallback, useEffect, useMemo, useState, type CSSProperties, type JSX } from 'react'
import type { Session } from '../lib/appAuth'
import { reportNowPlaying } from '../lib/activityReporter'
import { LivePlayer } from './LivePlayer'
import { EpgGrid } from './EpgGrid'
import { useSidebarWidth } from '../lib/useSidebarWidth'
import { loadSavedDimension, saveDimension, useResizableDimension } from '../lib/useResizableDimension'
import {
  addChannelToCategory,
  clearHistory,
  createCategory,
  deleteCategory,
  fetchPrefs,
  recordHistory,
  removeChannelFromCategory,
  renameCategory,
  setFavourite,
  type CustomCategory,
  type MediaKind,
  type PrefsState
} from '../lib/prefs'
import type { Category, LiveStream } from '../lib/types'

// The player's height cap is drag-resizable (see useResizableDimension.ts) via the row-resize
// handle on the seam between the player block and the EPG grid below. Defaults reproduce the
// old fixed behavior (video capped at 45vh); the max leaves room to keep the guide visible.
const PLAYER_MAX_HEIGHT_KEY = 'allison-web-iptv:player-max-height'
const PLAYER_MIN_HEIGHT = 120
const PLAYER_DEFAULT_MAX_HEIGHT = (): number => Math.round(window.innerHeight * 0.45)
const PLAYER_MAX_HEIGHT_CEILING = (): number => Math.round(window.innerHeight * 0.8)

const EMPTY_PREFS: PrefsState = { favourites: [], categories: [], history: [] }

// What the sidebar is currently showing. Favourites/History/custom categories are library views
// over the same channel data, not provider categories — hence one union rather than the single
// category id this used to hold.
type Selection =
  | { type: 'all' }
  | { type: 'provider'; id: string }
  | { type: 'favourites' }
  | { type: 'history' }
  | { type: 'custom'; id: number }

/** A library entry (favourite/history/custom channel) as a grid row. Only the fields the rows
 *  and the player actually use are meaningful; the rest exist to satisfy LiveStream. */
function synthesizeStream(streamId: number, name: string, category: string | null): LiveStream {
  return {
    num: 0,
    name,
    stream_type: 'live',
    stream_id: streamId,
    stream_icon: '',
    epg_channel_id: null,
    added: '',
    category_id: category ?? '',
    custom_sid: null,
    tv_archive: 0,
    direct_source: '',
    tv_archive_duration: 0
  }
}

export function LiveTv({ session, onOpenEpgSettings }: { session: Session; onOpenEpgSettings?: () => void }): JSX.Element {
  const [categories, setCategories] = useState<Category[]>([])
  const [selection, setSelection] = useState<Selection>({ type: 'all' })
  const [providerChannels, setProviderChannels] = useState<LiveStream[]>([])
  const [nowPlaying, setNowPlaying] = useState<LiveStream | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [prefs, setPrefs] = useState<PrefsState>(EMPTY_PREFS)
  const [prefsError, setPrefsError] = useState<string | null>(null)
  // Bulk "pick channels from any category into this custom category" mode.
  const [picking, setPicking] = useState(false)
  const [picked, setPicked] = useState<Set<number>>(new Set())
  const [newCategoryName, setNewCategoryName] = useState('')
  const [showNewCategory, setShowNewCategory] = useState(false)
  const [pickerSourceId, setPickerSourceId] = useState<string | null>(null)

  const { sidebarWidth, startSidebarDrag } = useSidebarWidth()
  const { dimension: playerMaxHeight, startDrag: startPlayerHeightDrag } = useResizableDimension(
    loadSavedDimension(PLAYER_MAX_HEIGHT_KEY, PLAYER_DEFAULT_MAX_HEIGHT(), PLAYER_MIN_HEIGHT, PLAYER_MAX_HEIGHT_CEILING()),
    'y',
    {
      min: PLAYER_MIN_HEIGHT,
      max: PLAYER_MAX_HEIGHT_CEILING(),
      onCommit: (h) => saveDimension(PLAYER_MAX_HEIGHT_KEY, h)
    }
  )

  const applyPrefs = useCallback((next: PrefsState): void => {
    setPrefs(next)
  }, [])

  const handlePrefsError = useCallback((err: unknown, fallback: string): void => {
    setPrefsError(err instanceof Error ? err.message : fallback)
  }, [])

  useEffect(() => {
    session.client
      .getLiveCategories()
      .then(setCategories)
      .catch((err) => setLoadError(err instanceof Error ? err.message : 'Failed to load categories'))
  }, [session])

  useEffect(() => {
    fetchPrefs()
      .then(applyPrefs)
      .catch((err) => handlePrefsError(err, 'Failed to load your favourites and categories'))
  }, [applyPrefs, handlePrefsError])

  // The provider's channel list is only fetched for the views that show it; library views render
  // from the stored entries instead, which is what makes them work even if a category is slow.
  useEffect(() => {
    if (selection.type !== 'all' && selection.type !== 'provider' && !picking) return
    const categoryId = selection.type === 'provider' ? selection.id : null
    session.client
      .getLiveStreams(categoryId ?? undefined)
      .then(setProviderChannels)
      .catch((err) => setLoadError(err instanceof Error ? err.message : 'Failed to load channels'))
  }, [session, selection, picking])

  useEffect(() => {
    reportNowPlaying(nowPlaying?.name ?? null, 'live')
  }, [nowPlaying])
  useEffect(() => () => reportNowPlaying(null), [])

  const liveFavourites = useMemo(() => prefs.favourites.filter((f) => f.kind === 'live'), [prefs.favourites])

  // History is a list of visits; the sidebar view is the distinct channels, most recent first.
  const historyChannels = useMemo(() => {
    const seen = new Set<number>()
    const rows: LiveStream[] = []
    for (const entry of prefs.history) {
      if (entry.kind !== 'live' || seen.has(entry.streamId)) continue
      seen.add(entry.streamId)
      rows.push(synthesizeStream(entry.streamId, entry.name, entry.category))
    }
    return rows
  }, [prefs.history])

  const selectedCustom: CustomCategory | null =
    selection.type === 'custom' ? prefs.categories.find((category) => category.id === selection.id) ?? null : null

  const channels: LiveStream[] = useMemo(() => {
    if (selection.type === 'favourites') {
      return liveFavourites.map((favourite) => synthesizeStream(favourite.streamId, favourite.name, favourite.category))
    }
    if (selection.type === 'history') return historyChannels
    if (selection.type === 'custom') {
      return (selectedCustom?.channels ?? [])
        .filter((channel) => channel.kind === 'live')
        .map((channel) => synthesizeStream(channel.streamId, channel.name, channel.sourceCategory))
    }
    return providerChannels
  }, [selection, liveFavourites, historyChannels, selectedCustom, providerChannels])

  const isFavourite = useCallback(
    (streamId: number): boolean => liveFavourites.some((favourite) => favourite.streamId === streamId),
    [liveFavourites]
  )

  const selectChannel = useCallback(
    (channel: LiveStream | null): void => {
      setNowPlaying(channel)
      if (!channel) return
      // Watching something is what history means here; failures are surfaced but never block play.
      void recordHistory({ kind: 'live', streamId: channel.stream_id, name: channel.name, category: channel.category_id })
        .then(() => fetchPrefs().then(applyPrefs))
        .catch((err) => handlePrefsError(err, 'Could not record watch history'))
    },
    [applyPrefs, handlePrefsError]
  )

  const toggleFavourite = useCallback(
    async (channel: LiveStream): Promise<void> => {
      try {
        const favourites = await setFavourite(
          { kind: 'live', streamId: channel.stream_id, name: channel.name, category: channel.category_id },
          !isFavourite(channel.stream_id)
        )
        applyPrefs({ ...prefs, favourites })
      } catch (err) {
        handlePrefsError(err, 'Could not update favourites')
      }
    },
    [applyPrefs, handlePrefsError, isFavourite, prefs]
  )

  const handleCreateCategory = useCallback(async (): Promise<void> => {
    const name = newCategoryName.trim()
    if (!name) return
    try {
      const next = await createCategory(name)
      applyPrefs({ ...prefs, categories: next })
      setNewCategoryName('')
      setShowNewCategory(false)
      const created = next.find((category) => category.name.toLowerCase() === name.toLowerCase())
      if (created) {
        setSelection({ type: 'custom', id: created.id })
        setPicking(true)
      }
    } catch (err) {
      handlePrefsError(err, 'Could not create the category')
    }
  }, [applyPrefs, handlePrefsError, newCategoryName, prefs])

  const handleSavePicks = useCallback(async (): Promise<void> => {
    if (!selectedCustom) return
    try {
      let categories = prefs.categories
      for (const channel of providerChannels) {
        if (picked.has(channel.stream_id)) {
          categories = await addChannelToCategory(selectedCustom.id, {
            kind: 'live',
            streamId: channel.stream_id,
            name: channel.name,
            category: channel.category_id
          })
        }
      }
      applyPrefs({ ...prefs, categories })
      setPicking(false)
      setPicked(new Set())
    } catch (err) {
      handlePrefsError(err, 'Could not save the selected channels')
    }
  }, [applyPrefs, handlePrefsError, picked, prefs, providerChannels, selectedCustom])

  const handleRemoveFromCategory = useCallback(
    async (channel: LiveStream): Promise<void> => {
      if (!selectedCustom) return
      try {
        const categories = await removeChannelFromCategory(selectedCustom.id, 'live', channel.stream_id)
        applyPrefs({ ...prefs, categories })
      } catch (err) {
        handlePrefsError(err, 'Could not remove that channel')
      }
    },
    [applyPrefs, handlePrefsError, prefs, selectedCustom]
  )

  const handleRename = useCallback(async (): Promise<void> => {
    if (!selectedCustom) return
    const name = window.prompt('Rename category', selectedCustom.name)?.trim()
    if (!name || name === selectedCustom.name) return
    try {
      applyPrefs({ ...prefs, categories: await renameCategory(selectedCustom.id, name) })
    } catch (err) {
      handlePrefsError(err, 'Could not rename the category')
    }
  }, [applyPrefs, handlePrefsError, prefs, selectedCustom])

  const handleDeleteCategory = useCallback(async (): Promise<void> => {
    if (!selectedCustom) return
    if (!window.confirm(`Delete "${selectedCustom.name}"? The channels stay in their own categories.`)) return
    try {
      applyPrefs({ ...prefs, categories: await deleteCategory(selectedCustom.id) })
      setSelection({ type: 'all' })
      setPicking(false)
    } catch (err) {
      handlePrefsError(err, 'Could not delete the category')
    }
  }, [applyPrefs, handlePrefsError, prefs, selectedCustom])

  const handleClearHistory = useCallback(async (): Promise<void> => {
    try {
      const history = await clearHistory()
      applyPrefs({ ...prefs, history })
    } catch (err) {
      handlePrefsError(err, 'Could not clear history')
    }
  }, [applyPrefs, handlePrefsError, prefs])

  const streamUrl = nowPlaying ? session.client.getStreamUrl('live', nowPlaying.stream_id, 'm3u8') : null
  const sectionTitle =
    selection.type === 'favourites'
      ? 'Favourites'
      : selection.type === 'history'
        ? 'Watch history'
        : selectedCustom?.name ?? 'All channels'

  return (
    <div className="app-body">
      <nav className="sidebar" style={{ width: sidebarWidth }}>
        <button
          className={selection.type === 'favourites' ? 'category-btn active' : 'category-btn'}
          onClick={() => {
            setSelection({ type: 'favourites' })
            setPicking(false)
          }}
        >
          ★ Favourites{liveFavourites.length > 0 ? ` (${liveFavourites.length})` : ''}
        </button>
        <button
          className={selection.type === 'history' ? 'category-btn active' : 'category-btn'}
          onClick={() => {
            setSelection({ type: 'history' })
            setPicking(false)
          }}
        >
          🕘 History
        </button>
        <button
          className={selection.type === 'all' ? 'category-btn active' : 'category-btn'}
          onClick={() => {
            setSelection({ type: 'all' })
            setPicking(false)
          }}
        >
          All
        </button>
        {categories.map((cat) => (
          <button
            key={cat.category_id}
            className={selection.type === 'provider' && selection.id === cat.category_id ? 'category-btn active' : 'category-btn'}
            onClick={() => {
              setSelection({ type: 'provider', id: cat.category_id })
              setPicking(false)
            }}
          >
            {cat.category_name}
          </button>
        ))}

        <div className="sidebar-section-label">My categories</div>
        {prefs.categories.map((category) => (
          <button
            key={category.id}
            className={selection.type === 'custom' && selection.id === category.id ? 'category-btn active' : 'category-btn'}
            onClick={() => {
              setSelection({ type: 'custom', id: category.id })
              setPicking(false)
            }}
          >
            {category.name} ({category.channels.length})
          </button>
        ))}
        {showNewCategory ? (
          <form
            className="sidebar-new-category"
            onSubmit={(e) => {
              e.preventDefault()
              void handleCreateCategory()
            }}
          >
            <input
              value={newCategoryName}
              onChange={(e) => setNewCategoryName(e.target.value)}
              placeholder="Category name"
              maxLength={40}
              autoFocus
            />
            <button type="submit" className="admin-small-btn">
              Create
            </button>
          </form>
        ) : (
          <button className="category-btn sidebar-add-category" onClick={() => setShowNewCategory(true)}>
            ＋ New category
          </button>
        )}

        <div
          className="resize-handle resize-handle--col resize-handle--sidebar"
          onPointerDown={startSidebarDrag}
          title="Drag to resize the sidebar"
        />
      </nav>

      <div className="content">
        {streamUrl && nowPlaying && (
          <div className="player-section" style={{ '--player-max-height': `${playerMaxHeight}px` } as CSSProperties}>
            <LivePlayer url={streamUrl} channelKey={`live:${nowPlaying.stream_id}`} />
            <div className="now-playing-bar">
              <span>Now playing: {nowPlaying.name}</span>
              <span className="now-playing-actions">
                <button
                  type="button"
                  className={isFavourite(nowPlaying.stream_id) ? 'prefs-action active' : 'prefs-action'}
                  onClick={() => void toggleFavourite(nowPlaying)}
                  title={isFavourite(nowPlaying.stream_id) ? 'Remove from favourites' : 'Add to favourites'}
                >
                  {isFavourite(nowPlaying.stream_id) ? '★' : '☆'}
                </button>
                {prefs.categories.length > 0 && (
                  <select
                    className="prefs-select"
                    value=""
                    title="Add this channel to one of your categories"
                    onChange={(e) => {
                      const id = Number(e.target.value)
                      if (!id) return
                      addChannelToCategory(id, {
                        kind: 'live',
                        streamId: nowPlaying.stream_id,
                        name: nowPlaying.name,
                        category: nowPlaying.category_id
                      })
                        .then((cats) => applyPrefs({ ...prefs, categories: cats }))
                        .catch((err) => handlePrefsError(err, 'Could not add the channel'))
                    }}
                  >
                    <option value="">＋ Category…</option>
                    {prefs.categories.map((category) => (
                      <option key={category.id} value={category.id}>
                        {category.name}
                      </option>
                    ))}
                  </select>
                )}
              </span>
            </div>
            <div
              className="resize-handle resize-handle--row"
              onPointerDown={startPlayerHeightDrag}
              title="Drag to resize the player"
            />
          </div>
        )}

        {(loadError || prefsError) && (
          <div className="login-error" style={{ padding: '8px 16px' }}>
            {loadError ?? prefsError}
          </div>
        )}

        <div className="list-toolbar">
          <span className="list-toolbar-title">{sectionTitle}</span>
          {selection.type === 'custom' && !picking && (
            <>
              <button type="button" className="admin-small-btn" onClick={() => setPicking(true)}>
                Add channels
              </button>
              <button type="button" className="admin-small-btn" onClick={() => void handleRename()}>
                Rename
              </button>
              <button type="button" className="admin-small-btn danger" onClick={() => void handleDeleteCategory()}>
                Delete
              </button>
            </>
          )}
          {selection.type === 'history' && prefs.history.length > 0 && (
            <button type="button" className="admin-small-btn" onClick={() => void handleClearHistory()}>
              Clear history
            </button>
          )}
        </div>

        {picking && selectedCustom ? (
          <div className="channel-picker">
            <div className="channel-picker-head">
              <span>
                Pick channels to add to <strong>{selectedCustom.name}</strong>
              </span>
              <select
                className="prefs-select"
                value={pickerSourceId ?? ''}
                onChange={(e) => {
                  const id = e.target.value
                  setPickerSourceId(id || null)
                  session.client
                    .getLiveStreams(id || undefined)
                    .then(setProviderChannels)
                    .catch((err) => setLoadError(err instanceof Error ? err.message : 'Failed to load channels'))
                }}
              >
                <option value="">All categories</option>
                {categories.map((cat) => (
                  <option key={cat.category_id} value={cat.category_id}>
                    {cat.category_name}
                  </option>
                ))}
              </select>
              <button type="button" className="admin-small-btn" onClick={() => void handleSavePicks()}>
                Add {picked.size > 0 ? `${picked.size} ` : ''}selected
              </button>
              <button
                type="button"
                className="admin-small-btn"
                onClick={() => {
                  setPicking(false)
                  setPicked(new Set())
                }}
              >
                Cancel
              </button>
            </div>
            <ul className="channel-picker-list">
              {providerChannels.map((channel) => (
                <li key={channel.stream_id}>
                  <label>
                    <input
                      type="checkbox"
                      checked={picked.has(channel.stream_id)}
                      onChange={(e) =>
                        setPicked((current) => {
                          const next = new Set(current)
                          if (e.target.checked) next.add(channel.stream_id)
                          else next.delete(channel.stream_id)
                          return next
                        })
                      }
                    />
                    <span>{channel.name}</span>
                    <span className="admin-muted">{channel.category_id ? `cat ${channel.category_id}` : ''}</span>
                  </label>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <EpgGrid
            session={session}
            channels={channels}
            activeStreamId={nowPlaying?.stream_id}
            onSelectChannel={selectChannel}
            onOpenEpgSettings={onOpenEpgSettings}
            emptyMessage={
              selection.type === 'favourites'
                ? 'No favourites yet — press ☆ on a channel while it plays.'
                : selection.type === 'history'
                  ? 'Nothing watched yet.'
                  : undefined
            }
          />
        )}
        {selection.type === 'custom' && !picking && selectedCustom && selectedCustom.channels.length === 0 && (
          <div className="list-hint">
            Empty category — use <strong>Add channels</strong> to pick channels from any category.
          </div>
        )}
      </div>
    </div>
  )
}

// Kept for the grid's own typing convenience: library rows are live-stream shaped.
export type { MediaKind }

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type JSX } from 'react'
import type { Session } from '../lib/appAuth'
import { reportNowPlaying } from '../lib/activityReporter'
import { LivePlayer } from './LivePlayer'
import { EpgGrid } from './EpgGrid'
import { ReorderableChannelList, type ReorderableRow } from './ReorderableChannelList'
import { useSidebarWidth } from '../lib/useSidebarWidth'
import { sectionTitle } from '../lib/sectionTitle'
import { providerLookup, resolveLibraryEntry, type LibraryEntry } from '../lib/libraryResolve'
import { loadStoredLibraryView, parseLibraryView, saveLibraryView, type LibraryView } from '../lib/libraryView'
import { loadSavedDimension, saveDimension, useResizableDimension } from '../lib/useResizableDimension'
import { newSessionId } from '../lib/sessionId'
import {
  addChannelToCategory,
  clearHistory,
  createCategory,
  deleteCategory,
  fetchPrefs,
  recordHistory,
  removeChannelFromCategory,
  reorderCategoryChannels,
  renameCategory,
  setFavouriteOrder,
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

const EMPTY_PREFS: PrefsState = { favourites: [], categories: [], history: [], resume: [] }

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

export function LiveTv({
  session,
  onOpenEpgSettings,
  playRequest,
  onPlayHandled
}: {
  session: Session
  onOpenEpgSettings?: () => void
  /** A search hit for this view to open (see App.tsx). */
  playRequest?: { kind: string; streamId: number; name: string; nonce: number } | null
  onPlayHandled?: () => void
}): JSX.Element {
  const [categories, setCategories] = useState<Category[]>([])
  // Favourites is the landing view: it is what someone checks first after signing in, and an
  // empty one explains itself (see the grid's emptyMessage) rather than showing nothing useful.
  const [selection, setSelection] = useState<Selection>({ type: 'favourites' })
  const [providerChannels, setProviderChannels] = useState<LiveStream[]>([])
  const [nowPlaying, setNowPlaying] = useState<LiveStream | null>(null)
  // Set when what is playing is a past programme rather than the live channel.
  const [catchup, setCatchup] = useState<{ startMs: number; stopMs: number; title: string } | null>(null)
  // Catch-up is raw MPEG-TS: hls.js parses playlists and Safari cannot decode MPEG-TS at all, so
  // the browser is handed this app's own HLS output instead — the same transcode machinery the
  // silent-audio fallback uses. Null while that transcode is starting.
  const [catchupStream, setCatchupStream] = useState<string | null>(null)
  const [catchupError, setCatchupError] = useState<string | null>(null)
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

  // A search result: switch the view to All so the channel is in context, and start it.
  useEffect(() => {
    if (!playRequest || playRequest.kind !== 'live') return
    setSelection({ type: 'all' })
    selectChannel(synthesizeStream(playRequest.streamId, playRequest.name, null))
    onPlayHandled?.()
  }, [playRequest?.nonce])

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

  // Library rows carry the id a channel had when they were saved, and this provider renumbers ids — so
  // a favourite saved before a renumbering asks for a stream that no longer exists and the provider
  // answers "channel unavailable", while the same channel plays from its category where the id is
  // current. Resolving against the provider's own entry (by id, then by name) fixes both that and the
  // archive flag a synthesised row never had. See lib/libraryResolve.ts for the measurement.
  const libraryEntries = useMemo((): LibraryEntry[] => {
    if (selection.type === 'favourites') {
      return liveFavourites.map((favourite) => ({ streamId: favourite.streamId, name: favourite.name, category: favourite.category }))
    }
    // History rows are the same shape of problem as favourites — an id from the day of the visit — and
    // they do carry their category, so the same per-category load and resolver apply unchanged.
    if (selection.type === 'history') {
      return prefs.history
        .filter((entry) => entry.kind === 'live')
        .map((entry) => ({ streamId: entry.streamId, name: entry.name, category: entry.category }))
    }
    if (selection.type === 'custom') {
      return (selectedCustom?.channels ?? [])
        .filter((channel) => channel.kind === 'live')
        .map((channel) => ({ streamId: channel.streamId, name: channel.name, category: channel.sourceCategory }))
    }
    return []
    }, [selection, liveFavourites, selectedCustom, prefs.history])

  const [libraryChannels, setLibraryChannels] = useState<LiveStream[]>([])
  const libraryCategoriesRef = useRef<Map<string, LiveStream[]>>(new Map())
  useEffect(() => {
    const wanted = [...new Set(libraryEntries.map((entry) => entry.category).filter((value): value is string => !!value))]
    if (wanted.length === 0) {
      setLibraryChannels([])
      return
    }
    let cancelled = false
    void (async () => {
      const collected: LiveStream[] = []
      for (const categoryId of wanted) {
        const cached = libraryCategoriesRef.current.get(categoryId)
        if (cached) {
          collected.push(...cached)
          continue
        }
        try {
          const loaded = await session.client.getLiveStreams(categoryId)
          libraryCategoriesRef.current.set(categoryId, loaded)
          collected.push(...loaded)
        } catch {
          // leave that category's rows exactly as stored; the provider may just be down
        }
      }
      if (!cancelled) setLibraryChannels(collected)
    })()
    return () => { cancelled = true }
  }, [libraryEntries, session.client])

  const libraryLookup = useMemo(() => providerLookup(libraryChannels), [libraryChannels])


  const channels: LiveStream[] = useMemo(() => {
    if (selection.type === 'favourites') {
      return liveFavourites.map(
        (favourite) =>
          resolveLibraryEntry(
            { streamId: favourite.streamId, name: favourite.name, category: favourite.category },
            libraryLookup
          ) ?? synthesizeStream(favourite.streamId, favourite.name, favourite.category)
      )
    }
    if (selection.type === 'history') {
      return historyChannels.map(
        (row) =>
          resolveLibraryEntry(
            { streamId: row.stream_id, name: row.name, category: row.category_id || null },
            libraryLookup
          ) ?? row
      )
    }
    if (selection.type === 'custom') {
      return (selectedCustom?.channels ?? [])
        .filter((channel) => channel.kind === 'live')
        .map(
          (channel) =>
            resolveLibraryEntry(
              { streamId: channel.streamId, name: channel.name, category: channel.sourceCategory },
              libraryLookup
            ) ?? synthesizeStream(channel.streamId, channel.name, channel.sourceCategory)
        )
    }
    return providerChannels
  }, [selection, liveFavourites, historyChannels, selectedCustom, providerChannels, libraryLookup])

  // Library views are plain lists (short, personal, reorderable); the guide grid stays for the
  // provider's own categories, where a virtualised 27k-row table is the right tool.
  // Artwork for library rows: the icon stored with the entry, falling back to the provider's
  // channel list when it happens to be loaded (e.g. after visiting All).
  const providerIconById = useMemo(() => {
    const map = new Map<number, string>()
    for (const channel of providerChannels) if (channel.stream_icon) map.set(channel.stream_id, channel.stream_icon)
    return map
  }, [providerChannels])

  // Reported as "the favourite EPG is missing": Favourites and custom categories were list-only,
  // so the guide did not exist for them. Both views earn their place — the list is where reordering
  // and removal live, the guide is where you see what is on — so this is a choice rather than a
  // replacement: defaulting to the guide for Favourites (what was asked for) and to the list for a
  // custom category, whose main actions ("Add channels", ✕) live in the list.
  const [libraryViewOverride, setLibraryViewOverride] = useState<LibraryView | null>(() => loadStoredLibraryView())
  const libraryView: LibraryView = libraryViewOverride ?? (selection.type === 'favourites' ? 'guide' : 'list')
  const chooseLibraryView = useCallback((view: LibraryView): void => {
    setLibraryViewOverride(view)
    saveLibraryView(view)
  }, [])

  // The guide draws a channel icon. Library rows carry their own (falling back to the provider's list
  // when it happens to be loaded), but the synthesised streams these views are built from carry
  // none — so borrow the row's.
  const guideChannels = useMemo(
    () =>
      channels.map((channel) =>
        channel.stream_icon ? channel : { ...channel, stream_icon: providerIconById.get(channel.stream_id) ?? '' }
      ),
    [channels, providerIconById]
  )
  // Rows are derived from `channels`, which has already been resolved against the provider — so a row
  // carries the id the channel *has*, not the one it had when it was saved. Passing the stored id here
  // was enough to defeat the resolution above: the click looks the row up in `channels` by that id,
  // misses, and falls back to a synthesised stream carrying the dead one. That is why a favourite could
  // still report "channel unavailable" after the fix meant to prevent it.
  const isLibraryView = selection.type === 'favourites' || selection.type === 'history' || selection.type === 'custom'
  const libraryRows: ReorderableRow[] = useMemo(
    () =>
      isLibraryView
        ? channels.map((channel) => ({
            key: `live:${channel.stream_id}`,
            streamId: channel.stream_id,
            name: channel.name,
            kind: 'live' as const,
            icon: providerIconById.get(channel.stream_id) ?? null
          }))
        : [],
    [isLibraryView, channels, providerIconById]
  )

  // Entries saved before artwork was stored have none. Rather than asking anyone to re-add them,
  // fetch the provider's channel list once per session, match by stream id, and persist what we
  // find — after which the icon is part of the entry itself.
  const iconBackfillRef = useRef(false)
  useEffect(() => {
    if (iconBackfillRef.current) return
    const isLibrary = selection.type === 'favourites' || selection.type === 'custom'
    if (!isLibrary) return
    const missing = libraryRows.filter((row) => !row.icon).slice(0, 50)
    if (missing.length === 0) {
      iconBackfillRef.current = true
      return
    }
    iconBackfillRef.current = true
    void session.client
      .getLiveStreams()
      .then(async (all) => {
        const icons = new Map(all.filter((channel) => channel.stream_icon).map((channel) => [channel.stream_id, channel.stream_icon]))
        let categories = prefs.categories
        let favourites = prefs.favourites
        for (const row of missing) {
          const icon = icons.get(row.streamId)
          if (!icon) continue
          if (selection.type === 'favourites') {
            favourites = await setFavourite({ kind: 'live', streamId: row.streamId, name: row.name, icon }, true)
          } else if (selectedCustom) {
            categories = await addChannelToCategory(selectedCustom.id, {
              kind: 'live',
              streamId: row.streamId,
              name: row.name,
              icon
            })
          }
        }
        applyPrefs({ ...prefs, favourites, categories })
      })
      .catch(() => {
        // A failed backfill just means no artwork this session; nothing else depends on it.
      })
  }, [applyPrefs, libraryRows, prefs, selectedCustom, selection, session])

  const handleLibraryReorder = useCallback(
    (ordered: ReorderableRow[]): void => {
      const payload = ordered.map((row) => ({ kind: row.kind, streamId: row.streamId }))
      if (selection.type === 'favourites') {
        void setFavouriteOrder(payload)
          .then((favourites) => applyPrefs({ ...prefs, favourites }))
          .catch((err) => handlePrefsError(err, 'Could not save the new order'))
      } else if (selection.type === 'custom' && selectedCustom) {
        void reorderCategoryChannels(selectedCustom.id, payload)
          .then((categories) => applyPrefs({ ...prefs, categories }))
          .catch((err) => handlePrefsError(err, 'Could not save the new order'))
      }
    },
    [applyPrefs, handlePrefsError, prefs, selectedCustom, selection]
  )

  const isFavourite = useCallback(
    (streamId: number): boolean => liveFavourites.some((favourite) => favourite.streamId === streamId),
    [liveFavourites]
  )

  const selectChannel = useCallback(
    (channel: LiveStream | null): void => {
      setNowPlaying(channel)
        setCatchup(null)
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
          {
            kind: 'live',
            streamId: channel.stream_id,
            name: channel.name,
            category: channel.category_id,
            icon: channel.stream_icon
          },
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

  // Playing a past programme: the same channel from the provider's archive. Set *after*
  // selectChannel, which clears it — selectChannel means "play this channel live".
  // Restarting something still on air: identical downstream to catch-up (the archive is asked
  // for the programme's start up to now), so it goes through the same transcode flow.
  const playRestart = useCallback(
    (channel: LiveStream, programme: { startMs: number; stopMs: number; title: string }): void => {
      selectChannel(channel)
      setCatchup({ startMs: programme.startMs, stopMs: Date.now(), title: programme.title })
    },
    [selectChannel]
  )

  const playCatchup = useCallback(
    (channel: LiveStream, programme: { startMs: number; stopMs: number; title: string }): void => {
      selectChannel(channel)
      setCatchup({ startMs: programme.startMs, stopMs: programme.stopMs, title: programme.title })
    },
    [selectChannel]
  )

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
            category: channel.category_id,
            icon: channel.stream_icon
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

  // Only these values decide which archive is playing. Depending on the `catchup` and
  // `nowPlaying` *objects* meant every unrelated re-render (a guide refresh, a channel list
  // update) re-ran this effect: the cleanup stops the transcode and a fresh one starts, so the
  // player was handed a new stream every few seconds and never got to play — a hang with nothing
  // in the console. Primitives cannot do that.
  const catchupChannelId = catchup && nowPlaying ? nowPlaying.stream_id : null
  const catchupStartMs = catchup ? catchup.startMs : null
  const catchupStopMs = catchup ? catchup.stopMs : null
  // The client is read through a ref, never a dependency. `appAuth` builds a fresh XtreamClient
  // every time the session is loaded, so as a dependency it re-ran this effect whenever anything
  // reloaded the session — which stops the running transcode and starts another. Measured: a new
  // session every 12 seconds, each killed 12 seconds later, forever. The ref always has the
  // current client without any of that.
  const clientRef = useRef(session.client)
  clientRef.current = session.client
  // Catch-up swaps this channel's live playlist for the provider's archive stream — the player, the
  // silent-audio fallback and the idle sweep all keep working untouched.
  // Starting a catch-up transcode, and stopping it again when the programme changes or the viewer
  // goes back to live: the session belongs to this playback, not to the channel.
  useEffect(() => {
    if (catchupChannelId === null || catchupStartMs === null || catchupStopMs === null) {
      setCatchupStream(null)
      return
    }
    const sourceUrl = clientRef.current.getTimeshiftUrl(
      catchupChannelId,
      Math.floor(catchupStartMs / 1000),
      Math.max(1, Math.ceil((catchupStopMs - catchupStartMs) / 60_000))
    )
    const sessionId = newSessionId()
    let cancelled = false
    setCatchupStream(null)
    setCatchupError(null)
    fetch('/api/transcode/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // isVod **true**: the archive is a *recorded* source, and ffmpeg reads it far faster than
      // real time (measured: ~11.6x). Live's rolling six-segment playlist then deletes segments
      // before the player can ask for them — the player gets a 404 for the segment it wants, gives
      // up, and stops the session a few seconds in (measured: media-sequence reached 61 within 25s
      // while only six segments survived). VOD's shape keeps every segment instead, which is also
      // what makes a programme scrubbable, and the disk guard already accounts for that.
      body: JSON.stringify({ sourceUrl, isVod: true, sessionId })
    })
      .then(async (res) => {
        if (!res.ok) throw new Error((await res.text()) || `Could not start catch-up (${res.status})`)
        return (await res.json()) as { url: string }
      })
      .then(({ url }) => {
        if (!cancelled) setCatchupStream(url)
      })
      .catch((err) => {
        if (!cancelled) setCatchupError(err instanceof Error ? err.message : 'Could not start catch-up')
      })
    return () => {
      cancelled = true
      void fetch('/api/transcode/stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId })
      }).catch(() => {})
    }
    }, [catchupChannelId, catchupStartMs, catchupStopMs])
  
  // Catch-up plays the transcoded HLS; everything else plays the live playlist.
  const streamUrl = nowPlaying
    ? catchup
      ? catchupStream
      : session.client.getStreamUrl('live', nowPlaying.stream_id, 'm3u8')
    : null
  // A provider category is a category: its name is what belongs above its channel list (and the
  // guide under it), not "All channels" — which is only true for the unfiltered selection.
  const providerCategoryName =
    selection.type === 'provider'
      ? categories.find((category) => String(category.category_id) === String(selection.id))?.category_name
      : undefined
  const sectionTitleText = sectionTitle(selection, { custom: selectedCustom?.name, provider: providerCategoryName })

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

      </nav>
      {/* The handle lives in the content column, not inside <nav>: the sidebar is a scroll
          container, so a handle inside it is clipped by its own overflow and — with a non-overlay
          scrollbar, which is what "there is a bar to scroll up and down" describes — sits
          underneath that scrollbar, which then takes the pointer instead. Reported repeatedly as
          "the category panel cannot be resized" while the EPG's own column handle (not inside a
          scroller) worked. Here nothing can cover it or clip it. */}
      <div className="content">
        <div
          className="resize-handle resize-handle--col resize-handle--sidebar"
          onPointerDown={startSidebarDrag}
          title="Drag to resize the sidebar"
        />

        {catchup && !catchupStream && !catchupError && (
          <div className="epg-note" style={{ padding: '8px 16px' }}>
            Preparing the catch-up stream — a few seconds the first time.
          </div>
        )}
        {streamUrl && nowPlaying && (
          <div className="player-section" style={{ '--player-max-height': `${playerMaxHeight}px` } as CSSProperties}>
            {/* A different source for the same channel: key it so the player reloads. */}
            <LivePlayer
              url={streamUrl}
              channelKey={catchup ? `live:${nowPlaying.stream_id}@${catchup.startMs}` : `live:${nowPlaying.stream_id}`}
            />
            <div className="now-playing-bar">
              <span>
                Now playing: {nowPlaying.name}
                {catchup ? ` — catch-up: ${catchup.title}` : ''}
              </span>
              {catchup && (
                <button
                  type="button"
                  className="admin-small-btn"
                  onClick={() => setCatchup(null)}
                  title="Go back to this channel live"
                >
                  Return to live
                </button>
              )}
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
                        category: nowPlaying.category_id,
                        icon: nowPlaying.stream_icon
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

        {(loadError || prefsError || catchupError) && (
          <div className="login-error" style={{ padding: '8px 16px' }}>
            {loadError ?? prefsError ?? catchupError}
          </div>
        )}

        <div className="list-toolbar">
          <span className="list-toolbar-title">{sectionTitleText}</span>
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
          {(selection.type === 'favourites' || selection.type === 'custom') && !picking && (
            <span className="view-toggle" role="group" aria-label="How to show these channels">
              <button
                type="button"
                className={libraryView === 'guide' ? 'admin-small-btn active' : 'admin-small-btn'}
                aria-pressed={libraryView === 'guide'}
                onClick={() => chooseLibraryView('guide')}
                title="Show the guide for these channels"
              >
                Guide
              </button>
              <button
                type="button"
                className={libraryView === 'list' ? 'admin-small-btn active' : 'admin-small-btn'}
                aria-pressed={libraryView === 'list'}
                onClick={() => chooseLibraryView('list')}
                title="Show the reorderable list"
              >
                List
              </button>
            </span>
          )}
          {selection.type === 'history' && prefs.history.length > 0 && (
            <button type="button" className="admin-small-btn" onClick={() => void handleClearHistory()}>
              Clear history
            </button>
          )}
        </div>

        {(selection.type === 'favourites' || selection.type === 'custom') && !picking && libraryView === 'guide' ? (
          <EpgGrid
            session={session}
            channels={guideChannels}
            activeStreamId={nowPlaying?.stream_id}
            onSelectChannel={selectChannel}
            onOpenEpgSettings={onOpenEpgSettings}
            onPlayCatchup={playCatchup}
            onRestartProgramme={playRestart}
            emptyMessage={
              selection.type === 'favourites' ? 'No favourites yet — press ☆ on a channel while it plays.' : undefined
            }
          />
        ) : (selection.type === 'favourites' || selection.type === 'history' || selection.type === 'custom') && !picking ? (
          <ReorderableChannelList
            rows={libraryRows}
            reorderable={selection.type !== 'history'}
            activeKey={nowPlaying ? `live:${nowPlaying.stream_id}` : undefined}
            emptyMessage={
              selection.type === 'favourites'
                ? 'No favourites yet — press ☆ on a channel while it plays.'
                : selection.type === 'history'
                  ? 'Nothing watched yet.'
                  : 'Empty category — use Add channels to pick channels from any category.'
            }
            onPlay={(row) =>
              selectChannel(
                channels.find((channel) => channel.stream_id === row.streamId) ?? synthesizeStream(row.streamId, row.name, null)
              )
            }
            onReorder={handleLibraryReorder}
            rowActions={(row) =>
              selection.type === 'favourites' ? (
                <button
                  type="button"
                  className="admin-small-btn"
                  title="Remove from favourites"
                  onClick={() => {
                    void setFavourite({ kind: 'live', streamId: row.streamId, name: row.name }, false)
                      .then((favourites) => applyPrefs({ ...prefs, favourites }))
                      .catch((err) => handlePrefsError(err, 'Could not update favourites'))
                  }}
                >
                  ✕
                </button>
              ) : selection.type === 'custom' && selectedCustom ? (
                <button
                  type="button"
                  className="admin-small-btn danger"
                  title="Remove from this category"
                  onClick={() => void handleRemoveFromCategory({ stream_id: row.streamId, name: row.name } as LiveStream)}
                >
                  ✕
                </button>
              ) : null
            }
          />
        ) : picking && selectedCustom ? (
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
            channels={guideChannels}
            activeStreamId={nowPlaying?.stream_id}
            onSelectChannel={selectChannel}
            onOpenEpgSettings={onOpenEpgSettings}
            onPlayCatchup={playCatchup}
            onRestartProgramme={playRestart}
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

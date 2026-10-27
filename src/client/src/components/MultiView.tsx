import { useEffect, useRef, useState, type JSX } from 'react'
import { XtreamClient } from '../lib/xtreamClient'
import type { Category, LiveStream } from '../lib/types'
import {
  loadMultiViewPrefs,
  resizeSlots,
  saveMultiViewPrefs,
  toggleActiveAudio,
  type MultiViewLayout,
  type MultiViewSlot
} from '../lib/multiViewPrefs'
import { connectionStatus, useConnectionCount, type ConnectionSnapshot, type PlaylistLimits } from '../lib/connectionBudget'
import { useMultiViewTile } from '../lib/useMultiViewTile'
import { MultiViewPicker } from './MultiViewPicker'

/**
 * Multi-view: a 2- or 4-tile grid of small live channels, ported from the desktop sibling and
 * re-cut for the one constraint that shapes everything here — **the provider allows ~2
 * concurrent connections**, and every tile is a real connection through this app's relay.
 * Consequences this component owns deliberately:
 *
 * - The grid is entered INSTEAD of the main player (LiveTv clears `nowPlaying` on entry), and
 *   playing a channel from the guide tears the grid down — the app never holds more connections
 *   than the surface it is showing.
 * - Tiles never convert. A channel whose audio needs the server's remux would spend a second
 *   provider connection on an ffmpeg session — worse than a tile that says so and stops. The
 *   main player remains the watch surface that can convert anything.
 * - At most one tile is unmuted (click a tile to make it the audio); the toggle sets
 *   `video.muted` directly rather than re-attaching, so unmuting never reloads the stream.
 *
 * The tile set and layout persist per device (lib/multiViewPrefs.ts) — a reloaded tab finds its
 * tiles where it left them.
 */

export interface MultiViewProps {
  client: XtreamClient
  categories: Category[]
  favourites: Array<{ streamId: number; name: string; playlistId?: string }>
  playlists: Array<{ id: string; label: string; channels: LiveStream[] }>
  /** Per-account connection ceilings from the provider (v0.86.0); the toolbar's sentence and the
   *  picker's block use the account's own number when it is known. */
  limits: PlaylistLimits
  /** Play a tile's channel in the main player — the grid exits when this fires. */
  onPlayInMain: (slot: MultiViewSlot) => void
}

function TileView({
  slot,
  index,
  activeAudio,
  url,
  onToggleAudio,
  onRemove,
  onPlayInMain
}: {
  slot: MultiViewSlot
  index: number
  activeAudio: number | null
  url: string
  onToggleAudio: (index: number) => void
  onRemove: (index: number) => void
  onPlayInMain: (slot: MultiViewSlot) => void
}): JSX.Element {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const { error } = useMultiViewTile(videoRef, url)
  const isActive = activeAudio === index
  // The audio toggle applies to the element directly — never a re-attach (that would reload the
  // tile's whole stream). The flip lands within the click's transient-activation window, which
  // is what allows unmuting a muted-autoplay video at all.
  useEffect(() => {
    if (videoRef.current) videoRef.current.muted = !isActive
  }, [isActive])
  return (
    <div
      className={`multiview-tile${isActive ? ' multiview-tile--active' : ''}`}
      onClick={() => onToggleAudio(index)}
      title={isActive ? 'Mute this tile' : 'Listen to this tile'}
    >
      <video ref={videoRef} autoPlay playsInline />
      <div className="multiview-tile-overlay">
        <span className="multiview-tile-name">
          {isActive ? '🔊 ' : '🔇 '}
          {slot.name}
        </span>
        <span className="multiview-tile-actions" onClick={(event) => event.stopPropagation()}>
          <button
            type="button"
            className="admin-small-btn"
            title="Play this channel in the main player (leaves multi-view)"
            onClick={() => onPlayInMain(slot)}
          >
            ⤢
          </button>
          <button
            type="button"
            className="admin-small-btn"
            title="Remove this tile"
            onClick={() => onRemove(index)}
          >
            ✕
          </button>
        </span>
      </div>
      {error && (
        <div className="multiview-tile-error" onClick={(event) => event.stopPropagation()}>
          {error} — this channel can’t decode as a tile; try it in the main player.
        </div>
      )}
    </div>
  )
}

export function MultiView({ client, categories, favourites, playlists, limits, onPlayInMain }: MultiViewProps): JSX.Element {
  const [prefs, setPrefs] = useState(() => loadMultiViewPrefs())
  const [activeAudio, setActiveAudio] = useState<number | null>(null)
  const [pickingSlot, setPickingSlot] = useState<number | null>(null)
  // The live count behind the toolbar's sentence and the picker's warning (v0.85.0) — polled
  // only while the grid is mounted, which is the only surface that adds connections in bulk.
  const connections: ConnectionSnapshot | null = useConnectionCount()
  // The primary's own number when the provider stated one: the sentence says it exactly instead
  // of "about 2" (v0.86.0). '' is the primary's key in the limits map.
  const connectionNote = connectionStatus(connections, limits[''] ?? null)

  // Slot changes derive from the PREVIOUS state inside the updater, never from a render-time
  // closure: several removals landing in one batch (the rig's teardown found this) each built
  // from the same stale snapshot and overwrote each other — only the last click survived.
  // Persistence rides an effect, so an updater stays pure and a change can't skip its save.
  useEffect(() => {
    saveMultiViewPrefs(prefs)
  }, [prefs])

  const setLayout = (layout: MultiViewLayout): void => {
    // A dropped tile's audio goes with it; the surviving indices keep their meaning.
    setActiveAudio((current) => (current !== null && current >= layout ? null : current))
    setPrefs((prev) => ({ layout, slots: resizeSlots(prev.slots, layout) }))
  }

  const assign = (index: number, slot: MultiViewSlot): void => {
    setPrefs((prev) => {
      const slots = resizeSlots([...prev.slots], prev.layout)
      slots[index] = slot
      return { layout: prev.layout, slots }
    })
    setPickingSlot(null)
  }

  const remove = (index: number): void => {
    setPrefs((prev) => {
      const slots = resizeSlots([...prev.slots], prev.layout)
      slots[index] = null
      return { layout: prev.layout, slots }
    })
    if (activeAudio === index) setActiveAudio(null)
  }

  return (
    <div className="player-section multiview-section" style={{ '--player-max-height': 'var(--player-max-height, 45vh)' } as React.CSSProperties}>
      <div className="multiview-toolbar">
        <strong>Multi-view</strong>
        <span className="view-toggle">
          {[2, 4].map((layout) => (
            <button
              key={layout}
              type="button"
              className={prefs.layout === layout ? 'active' : ''}
              onClick={() => setLayout(layout as MultiViewLayout)}
            >
              {layout} tiles
            </button>
          ))}
        </span>
        <span className="epg-note">{connectionNote.text}</span>
      </div>
      <div className={`multiview-grid multiview-grid--${prefs.layout}`}>
        {prefs.slots.map((slot, index) =>
          slot ? (
            <TileView
              key={`${slot.playlistId ?? ''}:${slot.streamId}`}
              slot={slot}
              index={index}
              activeAudio={activeAudio}
              url={
                slot.playlistId
                  ? new XtreamClient(slot.playlistId).getStreamUrl('live', slot.streamId, 'm3u8')
                  : client.getStreamUrl('live', slot.streamId, 'm3u8')
              }
              onToggleAudio={(clicked) => setActiveAudio((current) => toggleActiveAudio(current, clicked))}
              onRemove={remove}
              onPlayInMain={onPlayInMain}
            />
          ) : (
            <button
              key={`empty:${index}`}
              type="button"
              className="multiview-tile multiview-tile--empty"
              onClick={() => setPickingSlot(index)}
            >
              ＋ Add channel
            </button>
          )
        )}
      </div>
      {pickingSlot !== null && (
        <MultiViewPicker
          slotIndex={pickingSlot}
          client={client}
          categories={categories}
          favourites={favourites}
          playlists={playlists}
          connections={connections}
          limits={limits}
          slots={prefs.slots}
          onAssign={(slot) => assign(pickingSlot, slot)}
          onClose={() => setPickingSlot(null)}
        />
      )}
    </div>
  )
}

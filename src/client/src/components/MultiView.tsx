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

export function MultiView({ client, categories, favourites, playlists, onPlayInMain }: MultiViewProps): JSX.Element {
  const [prefs, setPrefs] = useState(() => loadMultiViewPrefs())
  const [activeAudio, setActiveAudio] = useState<number | null>(null)
  const [pickingSlot, setPickingSlot] = useState<number | null>(null)

  const update = (next: { layout?: MultiViewLayout; slots?: Array<MultiViewSlot | null> }): void => {
    setPrefs((prev) => {
      const layout = next.layout ?? prev.layout
      const slots = resizeSlots(next.slots ?? prev.slots, layout)
      const merged = { layout, slots }
      saveMultiViewPrefs(merged)
      return merged
    })
  }

  const setLayout = (layout: MultiViewLayout): void => {
    // A dropped tile's audio goes with it; the surviving indices keep their meaning.
    setActiveAudio((current) => (current !== null && current >= layout ? null : current))
    update({ layout })
  }

  const assign = (index: number, slot: MultiViewSlot): void => {
    const slots = [...prefs.slots]
    slots[index] = slot
    update({ slots })
    setPickingSlot(null)
  }

  const remove = (index: number): void => {
    const slots = [...prefs.slots]
    slots[index] = null
    update({ slots })
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
        <span className="epg-note">
          Each tile is a live connection — the provider allows about 2, so tiles beyond that may starve.
        </span>
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
          onAssign={(slot) => assign(pickingSlot, slot)}
          onClose={() => setPickingSlot(null)}
        />
      )}
    </div>
  )
}

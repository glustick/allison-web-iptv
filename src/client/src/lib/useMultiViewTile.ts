import { useEffect, useRef, useState } from 'react'
import Hls from 'hls.js'

/**
 * The multi-view tile's lightweight HLS attach — a deliberate counterpart to LivePlayer's full
 * machinery, ported from the desktop sibling's useHlsAttach with the web's own constraint baked
 * in: **no transcode fallback, ever**. A tile whose audio needs converting would otherwise ask
 * the server for an ffmpeg session, and a session holds one of the provider's ~2 concurrent
 * connections — a worse outcome than a tile that says so and stops (the connection arithmetic
 * that shapes the whole grid; see MultiView.tsx). A tile that cannot decode is a browse-surface
 * dead end, and the main player remains the watch surface that can convert it.
 *
 * Also deliberately absent: the recovery ladders, the silent-audio poll, the backgrounding
 * watchdog. A tile that stalls shows a frozen picture until the viewer removes it or picks a
 * different channel — the desktop sibling ships exactly this trade.
 */

/** Small buffers: four tiles sharing one browser should not each buffer like the main player.
 *  `ignorePlaylistParsingErrors` is LivePlayer's own measured setting for this provider, ported
 *  here after the first live tile test died on a fatal levelParsingError within seconds: these
 *  providers refresh live playlists with segment-sequence timelines hls.js's reconciliation
 *  can't consistently agree with, and with one flat rendition there is no alternate level to
 *  fall back to, so hls.js escalates straight to fatal (see LivePlayer.tsx's own comment). */
const TILE_HLS_CONFIG = {
  enableWorker: true,
  maxBufferLength: 15,
  maxMaxBufferLength: 30,
  ignorePlaylistParsingErrors: true
}

export interface MultiViewTileState {
  /** A fatal hls.js error: the tile stopped and shows its message. Null while playing/loading. */
  error: string | null
}

export function useMultiViewTile(videoRef: React.RefObject<HTMLVideoElement | null>, url: string | null): MultiViewTileState {
  const [error, setError] = useState<string | null>(null)
  // Muted state is applied to the element directly by the caller (video.muted = ...), never a
  // dependency here: re-attaching on an audio toggle would reload the tile's whole stream — the
  // desktop port's own documented gotcha, not repeated.
  const mutedRef = useRef(true)

  useEffect(() => {
    mutedRef.current = true
    setError(null)
    const video = videoRef.current
    if (!video || !url) return
    video.muted = true

    let hls: Hls | null = null
    if (url.endsWith('.m3u8') && Hls.isSupported()) {
      hls = new Hls(TILE_HLS_CONFIG)
      hls.loadSource(url)
      hls.attachMedia(video)
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (!data.fatal) return
        // Stop the instance: a fatal tile error is terminal by design — no retries, no
        // conversion, no ladder. The message names the details the main player would act on.
        hls?.destroy()
        hls = null
        setError(`Tile stopped: ${data.details}`)
      })
    } else {
      video.src = url
    }
    video.play().catch(() => {})
    return () => {
      hls?.destroy()
      video.removeAttribute('src')
      video.load()
    }
  }, [videoRef, url])

  return { error }
}

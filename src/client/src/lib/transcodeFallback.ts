import { useCallback, useEffect, useRef, useState } from 'react'
import { noteStreamNeedsTranscode } from './transcodeHints'
import { newSessionId } from './sessionId'
import type { ErrorData } from 'hls.js'

export interface TrackSelectionRequest {
  audioIndex?: number
  subtitleIndex?: number
}

export interface TrackSelectionResult {
  audioIndex: number
  subtitleIndex: number
}

export function resolveTrackSelection(
  requested: TrackSelectionRequest,
  audioTracks: Array<{ index: number }> = [],
  subtitleTracks: Array<{ index: number; supported?: boolean }> = []
): TrackSelectionResult {
  const audioIndex = audioTracks.some((track) => track.index === requested.audioIndex)
    ? requested.audioIndex ?? 0
    : audioTracks[0]?.index ?? 0

  const subtitleIndex = subtitleTracks.some((track) => track.index === requested.subtitleIndex && (track.supported ?? true))
    ? requested.subtitleIndex ?? 0
    : subtitleTracks.find((track) => track.supported ?? true)?.index ?? 0

  return { audioIndex, subtitleIndex }
}

/**
 * Ported from the desktop app's useTranscodeFallback.ts (same name, same detection logic) —
 * see that file's own doc comment for the full account of why these two failure shapes (a
 * fatal hls.js demux failure for Live TV, a non-fatal SourceBuffer codec rejection) both mean
 * "this is Dolby Digital/E-AC-3 audio, no amount of retrying fixes it."
 */
export function isUnsupportedAudioCodecError(data: ErrorData): boolean {
  return (
    (data.details === 'fragParsingError' && typeof data.reason === 'string' && /ec-?3|ac-?3/i.test(data.reason)) ||
    ((data.details === 'bufferAddCodecError' || data.details === 'bufferAppendError') &&
      typeof data.mimeType === 'string' &&
      data.mimeType.toLowerCase().includes('audio'))
  )
}

interface StartTranscodeResponse {
  sessionId: string
  url: string
}

/**
 * Simplified client-side port of the desktop app's own hook of the same name — same core
 * mechanism (spin up a server-side ffmpeg remux, swap the player onto its output), routed
 * through this project's own /api/transcode/* routes instead of window.api.transcode. This
 * pass includes track selection too, so the fallback can honor the source's available audio and
 * subtitle streams rather than always using the first one.
 */
export function useTranscodeFallback(): {
  getSourceUrl: (originalUrl: string) => string
  tryFallback: (data: ErrorData, originalUrl: string, onReload: () => void, onError?: (message: string) => void) => boolean
  tryFallbackForSilentAudio: (originalUrl: string, isVod: boolean, onReload: () => void, onError?: (message: string) => void) => boolean
  selectTracks: (requested: TrackSelectionRequest, audioTracks?: Array<{ index: number }>, subtitleTracks?: Array<{ index: number; supported?: boolean }>) => TrackSelectionResult
  reset: () => void
  beginRun: () => void
  /** True while the player is running off a local transcode session rather than the source. */
  hasSession: () => boolean
  /** Tears down the current session (if any) and starts a fresh one — the recovery path for a
   *  transcode whose output stopped advancing, where reloading the same dead session id would
   *  leave the picture frozen forever. */
  restartFallback: (originalUrl: string, onReload: () => void, onError?: (message: string) => void) => boolean
} {
  const transcodedUrlRef = useRef<string | null>(null)
  const triedRef = useRef(false)
  const awaitingRef = useRef(false)
  const sessionIdRef = useRef<string | null>(null)
  const [, forceRender] = useState(0)

  const stopSession = useCallback((sessionId: string | null): void => {
    if (!sessionId) return
    fetch('/api/transcode/stop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId })
    }).catch((err) => console.error('[transcode] failed to stop session:', err))
  }, [])
  const stopSessionRef = useRef(stopSession)
  stopSessionRef.current = stopSession

  // Leaving the player — switching tab, closing it, navigating away, reloading — used to leave
  // the server-side ffmpeg running: it stops only when something asks it to. The server now also
  // reaps idle sessions (see transcodeIdle.ts), but that takes a couple of minutes, and until then
  // a live transcode is holding one of the account's two provider connections. So say goodbye
  // explicitly, and use a beacon for the case where the page is going away and a fetch would be
  // cancelled before it left.
  useEffect(() => {
    const stopCurrent = (): void => {
      const sessionId = sessionIdRef.current
      if (!sessionId) return
      sessionIdRef.current = null
      transcodedUrlRef.current = null
      try {
        const body = new Blob([JSON.stringify({ sessionId })], { type: 'application/json' })
        navigator.sendBeacon?.('/api/transcode/stop', body)
      } catch {
        stopSessionRef.current(sessionId)
      }
    }
    window.addEventListener('pagehide', stopCurrent)
    return () => {
      window.removeEventListener('pagehide', stopCurrent)
      stopCurrent()
    }
  }, [])

  const reset = useCallback(() => {
    triedRef.current = false
    awaitingRef.current = false
    transcodedUrlRef.current = null
    const stale = sessionIdRef.current
    sessionIdRef.current = null
    stopSessionRef.current(stale)
  }, [])

  const beginRun = useCallback(() => {
    awaitingRef.current = false
  }, [])

  const getSourceUrl = useCallback((originalUrl: string) => transcodedUrlRef.current ?? originalUrl, [])

  const selectTracks = useCallback(
    (requested: TrackSelectionRequest, audioTracks: Array<{ index: number }> = [], subtitleTracks: Array<{ index: number; supported?: boolean }> = []) => {
      return resolveTrackSelection(requested, audioTracks, subtitleTracks)
    },
    []
  )

  const startFallback = useCallback(
    (originalUrl: string, isVod: boolean, onReload: () => void, onError?: (message: string) => void): void => {
      // A URL that is already this app's transcoder output must never be 'converted' again: the
      // fallback would start a second transcode of the same media, stop the first, and hand the player
      // a stream with no history. For live semantics (a rolling six-segment window) the player then
      // cannot fetch the segment it asks for, the watchdog fires again, and it repeats — measured as a
      // new transcode session every twelve seconds while a catch-up sat there looking hung. Every
      // fallback route funnels through here, and this comes before the "needs converting" hint so a
      // transient transcode URL can never be remembered.
      if (originalUrl.startsWith('/__transcode/')) return

      triedRef.current = true
      awaitingRef.current = true
      // This stream needed converting once, so it will again — the next play skips straight to it.
      noteStreamNeedsTranscode(originalUrl)
      const sessionId = newSessionId()
      sessionIdRef.current = sessionId
      fetch('/api/transcode/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourceUrl: originalUrl, isVod, sessionId })
      })
        .then(async (res) => {
          if (!res.ok) throw new Error((await res.text()) || `transcode start failed: ${res.status}`)
          return res.json() as Promise<StartTranscodeResponse>
        })
        .then(({ url }) => {
          transcodedUrlRef.current = url
          forceRender((n) => n + 1)
          onReload()
        })
        .catch((err) => {
          awaitingRef.current = false
          onError?.(err instanceof Error ? err.message : String(err))
        })
    },
    []
  )

  const tryFallback = useCallback(
    (data: ErrorData, originalUrl: string, onReload: () => void, onError?: (message: string) => void): boolean => {
      if (awaitingRef.current) return true
      if (!isUnsupportedAudioCodecError(data) || triedRef.current) return false
      startFallback(originalUrl, false, onReload, onError)
      return true
    },
    [startFallback]
  )

  // `isVod` is the caller's, not a constant: this hook is used by both LivePlayer (a live
  // channel) and NativeVideoPlayer (a movie/episode file). Hardcoding true here meant every live
  // silent-audio fallback was transcoded as if it were a seekable file — no `-live_start_index
  // -1` / `-reconnect*` (the signed-URL expiry race those exist for, see transcodeService), and
  // VOD's 240s start deadline instead of live's 45s.
  const tryFallbackForSilentAudio = useCallback(
    (originalUrl: string, isVod: boolean, onReload: () => void, onError?: (message: string) => void): boolean => {
      if (awaitingRef.current || triedRef.current) return false
      startFallback(originalUrl, isVod, onReload, onError)
      return true
    },
    [startFallback]
  )

  const hasSession = useCallback((): boolean => transcodedUrlRef.current !== null, [])

  const restartFallback = useCallback(
    (originalUrl: string, onReload: () => void, onError?: (message: string) => void): boolean => {
      // Drop the dead session first so the replacement gets its own /__transcode/<id>/ output.
      const stale = sessionIdRef.current
      sessionIdRef.current = null
      transcodedUrlRef.current = null
      stopSession(stale)
      triedRef.current = true
      startFallback(originalUrl, false, onReload, onError)
      return true
    },
    [startFallback, stopSession]
  )

  return {
    getSourceUrl,
    tryFallback,
    tryFallbackForSilentAudio,
    selectTracks,
    reset,
    beginRun,
    hasSession,
    restartFallback
  }
}

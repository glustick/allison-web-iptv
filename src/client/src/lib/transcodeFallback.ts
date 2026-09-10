import { useCallback, useRef, useState } from 'react'
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
  tryFallbackForSilentAudio: (originalUrl: string, onReload: () => void, onError?: (message: string) => void) => boolean
  selectTracks: (requested: TrackSelectionRequest, audioTracks?: Array<{ index: number }>, subtitleTracks?: Array<{ index: number; supported?: boolean }>) => TrackSelectionResult
  reset: () => void
  beginRun: () => void
} {
  const transcodedUrlRef = useRef<string | null>(null)
  const triedRef = useRef(false)
  const awaitingRef = useRef(false)
  const sessionIdRef = useRef<string | null>(null)
  const [, forceRender] = useState(0)

  const reset = useCallback(() => {
    triedRef.current = false
    awaitingRef.current = false
    transcodedUrlRef.current = null
    const stale = sessionIdRef.current
    sessionIdRef.current = null
    if (stale) {
      fetch('/api/transcode/stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: stale })
      }).catch((err) => console.error('[transcode] failed to stop abandoned session:', err))
    }
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
      triedRef.current = true
      awaitingRef.current = true
      const sessionId = crypto.randomUUID()
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

  const tryFallbackForSilentAudio = useCallback(
    (originalUrl: string, onReload: () => void, onError?: (message: string) => void): boolean => {
      if (awaitingRef.current || triedRef.current) return false
      startFallback(originalUrl, true, onReload, onError)
      return true
    },
    [startFallback]
  )

  return { getSourceUrl, tryFallback, tryFallbackForSilentAudio, selectTracks, reset, beginRun }
}

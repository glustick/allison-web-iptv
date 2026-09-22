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

/**
 * Which shape the *stall* ladder should rebuild a live stream in.
 *
 * Two rules, both shaped by one principle: a stall must never cost picture quality. Trading
 * resolution for smoothness is sometimes the only way to keep a picture moving, but it is the
 * viewer's picture, and a player's job is to show the stream the provider sent.
 *
 * 1. **On a session** the session is replaced in place. v0.46.1 briefly escalated a stalled
 *    stream-copying session to the *video re-encode* tier; that quietly downscaled the channel for
 *    anyone whose stream stuttered, to work around a relay problem, without anyone asking for it.
 *    Removed. The re-encode tier still exists as the media-error ladder's **last resort** (v0.45.0),
 *    where the alternative is no picture at all — and since v0.46.3 it keeps the source's resolution
 *    unless an operator opts into a cap.
 * 2. **Not on a session** — the provider's own stream, relayed — a reload fixes a wedged *player*
 *    but not a source the host cannot sustain, and once the reloads are spent the ladder used to
 *    give up outright while every other path in this app converts. So the last rung converts,
 *    deliberately to the *cheap copy tier*: nothing here claims the video is undecodable, only that
 *    relaying it is not working, and a remux changes no pixels.
 *
 * Deliberately a pure function (node-only vitest, same convention as liveStreamRecovery.ts) so every
 * rule is testable without a browser or an hls.js instance.
 */
/** How many full-source reloads a run spends before a direct stream is converted instead. Matches
 *  the count at which the ladder would otherwise give up, so this replaces the terminal error
 *  rather than adding a step before it. */
export const STALL_RELOADS_BEFORE_CONVERTING = 3

export type StallRecoveryShape =
  /** Rebuild the source (the player's own reload path) — a wedged *player*, not a dead stream. */
  | 'reload'
  /** Hand the provider's own stream to the transcoder (the cheap copy tier) instead of giving up. */
  | 'convert'
  /** Replace the session in place, keeping its current shape. */
  | 'session'
  /** Nothing left to try: stop, and say so. */
  | 'give-up'

export function stallRecoveryShape(state: {
  /** True when the player is running off a transcode session's own output. */
  onTranscodeSession: boolean
  /** True once the video re-encode tier has been used in this run — the media-error ladder's last
   *  resort, and the point past which this ladder has nothing left to offer. */
  videoTranscodeTried: boolean
  /** Full-source reloads this run has already spent (LivePlayer's own ladder). */
  reloadAttempts: number
}): StallRecoveryShape {
  // A stalled session is replaced in place, in the shape it already has. Never escalated to a
  // re-encode: see the note above. (v0.48.2 removed the last rung that could reach one at all —
  // live TV here plays natively or reports that it cannot.)
  if (state.onTranscodeSession) return 'session'
  // The provider's own stream, relayed: reload it while reloads remain, then convert it rather than
  // declaring it unrecoverable — the same move every other reload path in this app makes.
  if (state.reloadAttempts >= STALL_RELOADS_BEFORE_CONVERTING) {
    return state.videoTranscodeTried ? 'give-up' : 'convert'
  }
  return 'reload'
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
  tryFallbackForSilentAudio: (originalUrl: string, isVod: boolean, onReload: () => void, onError?: (message: string) => void, videoTranscode?: boolean) => boolean
  selectTracks: (requested: TrackSelectionRequest, audioTracks?: Array<{ index: number }>, subtitleTracks?: Array<{ index: number; supported?: boolean }>) => TrackSelectionResult
  reset: () => void
  beginRun: () => void
  /** True while the player is running off a local transcode session rather than the source. */
  hasSession: () => boolean
  /** Tears down the current session (if any) and starts a fresh one — the recovery path for a
   *  transcode whose output stopped advancing, where reloading the same dead session id would
   *  leave the picture frozen forever. */
  restartFallback: (originalUrl: string, onReload: () => void, onError?: (message: string) => void) => boolean
  /** The last rung of the live recovery ladder: a session whose stream-copied video the browser
   *  cannot decode is replaced by one that re-encodes the video to H.264. Refuses a second try. */
  escalateToVideoTranscode: (originalUrl: string, onReload: () => void, onError?: (message: string) => void) => boolean
  /** Whether the video re-encode tier has already been tried in this run. */
  hasTriedVideoTranscode: () => boolean
} {
  const transcodedUrlRef = useRef<string | null>(null)
  const triedRef = useRef(false)
  const awaitingRef = useRef(false)
  const sessionIdRef = useRef<string | null>(null)
  // How the *current* session is being produced (stream-copy vs full video re-encode), so a
  // recovery restart replaces it with the same shape rather than regressing a channel this browser
  // can only play as H.264 back to a copy it cannot decode. videoTriedRef bounds the escalation to
  // one attempt per run.
  const videoModeRef = useRef(false)
  const videoTriedRef = useRef(false)
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
    videoModeRef.current = false
    videoTriedRef.current = false
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
    (originalUrl: string, isVod: boolean, onReload: () => void, onError?: (message: string) => void, videoTranscode = false): void => {
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
      videoModeRef.current = videoTranscode
      if (videoTranscode) videoTriedRef.current = true
      // This stream needed converting once, so it will again — the next play skips straight to it.
      // Only ever *upgrades* the hint to "needs the video re-encode too": an ordinary audio-only
      // fallback for a channel that previously needed the video tier must not clear that flag and
      // cost the next play a second, doomed copy session. (Undefined = leave the flag as found.)
      noteStreamNeedsTranscode(originalUrl, undefined, videoTranscode ? true : undefined)
      const sessionId = newSessionId()
      sessionIdRef.current = sessionId
      fetch('/api/transcode/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourceUrl: originalUrl, isVod, sessionId, videoTranscode })
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
    (originalUrl: string, isVod: boolean, onReload: () => void, onError?: (message: string) => void, videoTranscode = false): boolean => {
      if (awaitingRef.current || triedRef.current) return false
      startFallback(originalUrl, isVod, onReload, onError, videoTranscode)
      return true
    },
    [startFallback]
  )

  const hasSession = useCallback((): boolean => transcodedUrlRef.current !== null, [])

  // The stall ladder's question about this run — see stallRecoveryShape, which is what turns it into
  // a decision. (The session's own shape is still preserved by the restart itself, below.)
  const hasTriedVideoTranscode = useCallback((): boolean => videoTriedRef.current, [])

  const restartFallback = useCallback(
    (originalUrl: string, onReload: () => void, onError?: (message: string) => void): boolean => {
      // Drop the dead session first so the replacement gets its own /__transcode/<id>/ output.
      const stale = sessionIdRef.current
      sessionIdRef.current = null
      transcodedUrlRef.current = null
      stopSession(stale)
      triedRef.current = true
      // Preserve the current session's shape — a channel that only plays as re-encoded H.264 must
      // not be restarted as a stream-copy after a stall.
      startFallback(originalUrl, false, onReload, onError, videoModeRef.current)
      return true
    },
    [startFallback, stopSession]
  )

  // The bottom rung of the live media-error ladder (see LivePlayer's MEDIA_ERROR terminal branch).
  // Arriving here means the player is already on the transcoder's output and still cannot decode
  // it — the HEVC-incapable-browser case, where the session stream-copies HEVC the browser claimed
  // to support and then failed to append. Replace it with a session that re-encodes the video to
  // H.264. Bounded to one attempt so a channel that fails even that gives up instead of looping.
  const escalateToVideoTranscode = useCallback(
    (originalUrl: string, onReload: () => void, onError?: (message: string) => void): boolean => {
      if (awaitingRef.current || videoTriedRef.current) return false
      // Drop the undecodable session first so the replacement gets its own /__transcode/<id>/ output.
      const stale = sessionIdRef.current
      sessionIdRef.current = null
      transcodedUrlRef.current = null
      stopSession(stale)
      triedRef.current = true
      startFallback(originalUrl, false, onReload, onError, true)
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
    restartFallback,
    escalateToVideoTranscode,
    hasTriedVideoTranscode
  }
}

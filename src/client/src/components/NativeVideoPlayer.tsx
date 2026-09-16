import { useEffect, useRef, useState, type JSX } from 'react'
import Hls from 'hls.js'
import { useTranscodeFallback } from '../lib/transcodeFallback'
import { useSessionExpired } from '../lib/sessionWatch'
import { evaluatePlaybackSample, type PlaybackWatchState } from '../lib/playbackRecovery'
import { TrackControls, type PlayerTrack } from './TrackControls'

const SILENT_AUDIO_CHECK_INTERVAL_MS = 1000
// Long enough for the detach above to actually land at the origin, short enough not to be
// felt. This used to be 8s, and every one of those seconds was spent with the viewer looking
// at a frozen frame *before* ffmpeg had even been asked to start.
const CONNECTION_RELEASE_DELAY_MS = 2000

// webkitVideoDecodedByteCount/webkitAudioDecodedByteCount are real, long-standing Chromium
// <video> properties (ported check from the desktop app's Player.tsx) — not in the standard
// HTMLVideoElement type, hence this narrow structural extension rather than a full redeclare.
interface ChromiumVideoElement extends HTMLVideoElement {
  webkitVideoDecodedByteCount?: number
  webkitAudioDecodedByteCount?: number
}

// VOD/series normally play via a plain native `<video src>` (Xtream serves these as a direct
// file, not hls.js-driven) — but once the EC-3/silent-audio fallback below successfully swaps
// in a source, that source IS an HLS output (ffmpeg's own remux), and a bare `<video src>`
// can't parse that at all outside Safari (confirmed live: a real fallback here loaded and
// played its own segments fine over the network, but the native element still failed with
// `PipelineStatus::DEMUXER_ERROR_COULD_NOT_PARSE` — Chromium's native player has no HLS
// support, only hls.js does). So this checks the actual source in play each time, exactly like
// the desktop app's own Player.tsx does for the same reason, and only runs the silent-audio
// polling detection against the *original*, non-hls.js source — once the fallback is active,
// hls.js's own ERROR event covers it instead, and there's nothing left needing the poll.
export function NativeVideoPlayer({
  url,
  titleKey,
  initialPositionSeconds,
  onProgress
}: {
  url: string
  titleKey: string
  /** Where to resume from. Applied once, only if it is safely inside the title. */
  initialPositionSeconds?: number
  /** Called with the current position/duration as playback proceeds, on pause, on seek and at
   *  the end — the caller persists it; the player decides nothing about storage. */
  onProgress?: (positionSeconds: number, durationSeconds: number | null) => void
}): JSX.Element {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  
  // A restarted or expired session looks exactly like a stall: the player keeps refreshing its
  // playlist, each refresh now answers 401, and the picture stops advancing with nothing on
  // screen. Ask the server, and say so when the answer is no.
  const sessionExpired = useSessionExpired(true)

  // Nothing the player does can succeed once the session is gone, so stop pretending.
  useEffect(() => {
    if (sessionExpired) videoRef.current?.pause()
  }, [sessionExpired])
  const hlsRef = useRef<Hls | null>(null)
  const [reloadTick, setReloadTick] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [preparing, setPreparing] = useState(false)
  const [audioTracks, setAudioTracks] = useState<PlayerTrack[]>([])
  const [subtitleTracks, setSubtitleTracks] = useState<PlayerTrack[]>([])
  const [audioTrack, setAudioTrack] = useState(-1)
  const [subtitleTrack, setSubtitleTrack] = useState(-1)
  const { getSourceUrl, tryFallbackForSilentAudio, reset, beginRun } = useTranscodeFallback()

  useEffect(() => {
    reset()
    setPreparing(false)
  }, [titleKey, reset])

  // Kept in a ref so the reporting interval always calls the current callback without the
  // effect (and therefore the player) being rebuilt when a parent re-renders.
  const onProgressRef = useRef(onProgress)
  onProgressRef.current = onProgress

  useEffect(() => {
    const video = videoRef.current as ChromiumVideoElement | null
    if (!video) return
    setError(null)
    beginRun()

    // Resume: applied once per source, and only when the position is comfortably inside the
    // title — resuming into the last few seconds is worse than starting over.
    let resumeApplied = false
    const applyResume = (): void => {
      if (resumeApplied) return
      const target = initialPositionSeconds ?? 0
      resumeApplied = true
      if (target <= 5) return
      const duration = video.duration
      if (Number.isFinite(duration) && duration > 0 && target > duration - 15) return
      try {
        video.currentTime = target
      } catch {
        // A stream that isn't seekable yet simply plays from the start.
      }
    }
    video.addEventListener('loadedmetadata', applyResume)

    const report = (): void => {
      const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : null
      onProgressRef.current?.(video.currentTime, duration)
    }
    const reportIfPlaying = (): void => {
      if (!video.paused) report()
    }
    const progressTimer = setInterval(reportIfPlaying, 10_000)
    video.addEventListener('pause', report)
    video.addEventListener('seeked', report)
    video.addEventListener('ended', report)
    window.addEventListener('pagehide', report)
    const markPlaying = (): void => setPreparing(false)
    video.addEventListener('playing', markPlaying)
    const sourceUrl = getSourceUrl(url)
    const isM3u8 = sourceUrl.endsWith('.m3u8')

    if (isM3u8 && Hls.isSupported()) {
      // The fallback output is ffmpeg's *event* playlist — segments keep appending until the
      // source ends, so there is no #EXT-X-ENDLIST and hls.js reads it as a live stream. Its
      // default live sync wants three segment-durations of runway (12s at -hls_time 4) before
      // it will start, even when segments are already sitting there. One is enough for a
      // progressive remux that produces faster than realtime: start as soon as a segment
      // exists and let it buffer ahead from there.
      const hls = new Hls({ liveSyncDurationCount: 1 })
      hlsRef.current = hls
      hls.loadSource(sourceUrl)
      hls.attachMedia(video)
      hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, (_event, data) => {
        setAudioTracks(data.audioTracks.map((track, index) => ({ index, name: track.name, lang: track.lang, default: track.default })))
        setAudioTrack(hls.audioTrack)
      })
      hls.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, (_event, data) => {
        setSubtitleTracks(data.subtitleTracks.map((track, index) => ({ index, name: track.name, lang: track.lang, default: track.default })))
        setSubtitleTrack(hls.subtitleTrack)
      })
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (data.fatal) {
          console.error('[player] fatal hls error on fallback output', data.type, data.details)
          setError(`Playback error: ${data.details}`)
        }
      })
      video.play().catch(() => {})
      return () => {
        report()
        clearInterval(progressTimer)
        video.removeEventListener('playing', markPlaying)
        video.removeEventListener('loadedmetadata', applyResume)
        video.removeEventListener('pause', report)
        video.removeEventListener('seeked', report)
        video.removeEventListener('ended', report)
        window.removeEventListener('pagehide', report)
        hls.destroy()
        hlsRef.current = null
        setAudioTracks([])
        setSubtitleTracks([])
        setAudioTrack(-1)
        setSubtitleTrack(-1)
        video.removeAttribute('src')
        video.load()
      }
    }

    video.src = sourceUrl
    video.play().catch(() => {})

    let attempts = 0
    let watchState: PlaybackWatchState = { consecutiveSilentTicks: 0, everDecodedVideo: false }
    let releaseTimer: ReturnType<typeof setTimeout> | null = null
    let fallbackStarted = false

    // Starts the fallback exactly once, whichever trigger gets there first. Pausing and
    // detaching before the short release delay is what keeps this from opening a second
    // connection to the same source while the first is still in flight — two concurrent
    // requests for one file is a confirmed way to trip this provider.
    const startFallback = (reason: 'silent-audio' | 'unplayable'): void => {
      if (fallbackStarted) return
      fallbackStarted = true
      clearInterval(pollTimer)
      video.removeEventListener('error', onMediaError)
      video.pause()
      video.removeAttribute('src')
      video.load()
      setPreparing(true)
      releaseTimer = setTimeout(() => {
        tryFallbackForSilentAudio(
          url,
          // A movie/episode: a real seekable file, so VOD's segment window and start deadline.
          true,
          () => setReloadTick((t) => t + 1),
          (message) => {
            setPreparing(false)
            setError(
              `${reason === 'unplayable' ? "This title's format isn't supported by this player" : 'Audio codec not supported by this player'}, and automatic transcoding failed: ${message}`
            )
          }
        )
      }, CONNECTION_RELEASE_DELAY_MS)
    }

    // A container the browser can't demux fails *immediately* with an error event, so there is
    // no reason to sit through the polling budget first — which is exactly what used to happen:
    // no media error was ever listened for, so a title like this one (H.264 + Dolby E-AC-3 in
    // Matroska, which Chromium won't demux) decoded nothing, never tripped the silent-audio
    // test, and fell all the way through to the hard cap before transcoding even began.
    const onMediaError = (): void => startFallback('unplayable')
    video.addEventListener('error', onMediaError)

    const pollTimer = setInterval(() => {
      attempts += 1
      const verdict = evaluatePlaybackSample(
        watchState,
        {
          videoBytes: video.webkitVideoDecodedByteCount ?? 0,
          audioBytes: video.webkitAudioDecodedByteCount ?? 0
        },
        attempts
      )
      watchState = verdict.state
      if (verdict.verdict === 'wait') return
      startFallback(verdict.verdict)
    }, SILENT_AUDIO_CHECK_INTERVAL_MS)

    return () => {
      report()
      clearInterval(pollTimer)
      clearInterval(progressTimer)
      video.removeEventListener('error', onMediaError)
      video.removeEventListener('playing', markPlaying)
      video.removeEventListener('loadedmetadata', applyResume)
      video.removeEventListener('pause', report)
      video.removeEventListener('seeked', report)
      video.removeEventListener('ended', report)
      window.removeEventListener('pagehide', report)
      if (releaseTimer) clearTimeout(releaseTimer)
      video.removeAttribute('src')
      video.load()
    }
  }, [titleKey, reloadTick, initialPositionSeconds])

  return (
    <div className="player-wrap">
      <video ref={videoRef} controls />
      <TrackControls
        audioTracks={audioTracks}
        audioTrack={audioTrack}
        onAudioChange={(index) => {
          setAudioTrack(index)
          if (hlsRef.current) hlsRef.current.audioTrack = index
        }}
        subtitleTracks={subtitleTracks}
        subtitleTrack={subtitleTrack}
        onSubtitleChange={(index) => {
          setSubtitleTrack(index)
          if (hlsRef.current) hlsRef.current.subtitleTrack = index
        }}
      />
      {sessionExpired && (
        <div className="player-error" role="status">
          <span>Your session expired — sign in again to keep watching.</span>
          <button type="button" className="admin-small-btn" onClick={() => window.location.reload()}>
            Sign in again
          </button>
        </div>
      )}
      {preparing && !error && (
        <div className="player-notice" role="status">
          Converting this title for playback — this can take up to a minute the first time.
        </div>
      )}
      {!sessionExpired && error && <div className="login-error" style={{ padding: '6px 16px' }}>{error}</div>}
    </div>
  )
}

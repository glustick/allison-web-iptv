import { useEffect, useRef, useState, type JSX } from 'react'
import Hls from 'hls.js'
import { useTranscodeFallback } from '../lib/transcodeFallback'
import { TrackControls, type PlayerTrack } from './TrackControls'

const SILENT_AUDIO_CHECK_INTERVAL_MS = 1000
const SILENT_AUDIO_MAX_CHECK_ATTEMPTS = 90
const CONNECTION_RELEASE_DELAY_MS = 8000

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
export function NativeVideoPlayer({ url, titleKey }: { url: string; titleKey: string }): JSX.Element {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const hlsRef = useRef<Hls | null>(null)
  const [reloadTick, setReloadTick] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [audioTracks, setAudioTracks] = useState<PlayerTrack[]>([])
  const [subtitleTracks, setSubtitleTracks] = useState<PlayerTrack[]>([])
  const [audioTrack, setAudioTrack] = useState(-1)
  const [subtitleTrack, setSubtitleTrack] = useState(-1)
  const { getSourceUrl, tryFallbackForSilentAudio, reset, beginRun } = useTranscodeFallback()

  useEffect(() => {
    reset()
  }, [titleKey, reset])

  useEffect(() => {
    const video = videoRef.current as ChromiumVideoElement | null
    if (!video) return
    setError(null)
    beginRun()
    const sourceUrl = getSourceUrl(url)
    const isM3u8 = sourceUrl.endsWith('.m3u8')

    if (isM3u8 && Hls.isSupported()) {
      const hls = new Hls()
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

    let consecutiveSilentTicks = 0
    let attempts = 0
    let everDecodedVideo = false
    let releaseTimer: ReturnType<typeof setTimeout> | null = null
    const pollTimer = setInterval(() => {
      attempts += 1
      const videoBytes = video.webkitVideoDecodedByteCount ?? 0
      const audioBytes = video.webkitAudioDecodedByteCount ?? 0
      if (videoBytes > 0) everDecodedVideo = true
      consecutiveSilentTicks = videoBytes > 0 && audioBytes === 0 ? consecutiveSilentTicks + 1 : 0

      const confirmedSilentAudio = consecutiveSilentTicks >= 2
      const timedOut = attempts >= SILENT_AUDIO_MAX_CHECK_ATTEMPTS
      const confirmedUnplayableFormat = timedOut && !everDecodedVideo
      if (!confirmedSilentAudio && !timedOut) return
      clearInterval(pollTimer)
      if (!confirmedSilentAudio && !confirmedUnplayableFormat) return

      // Two concurrent requests for the same source (this still-open one, plus ffmpeg about to
      // open it too) is a real, previously-confirmed way to trip the provider — pausing and
      // detaching first, same as the desktop app, avoids the contention instead of hoping the
      // origin tolerates it.
      video.pause()
      video.removeAttribute('src')
      video.load()
      releaseTimer = setTimeout(() => {
        tryFallbackForSilentAudio(
          url,
          () => setReloadTick((t) => t + 1),
          (message) =>
            setError(
              `${confirmedUnplayableFormat ? "This title's format isn't supported by this player" : 'Audio codec not supported by this player'}, and automatic transcoding failed: ${message}`
            )
        )
      }, CONNECTION_RELEASE_DELAY_MS)
    }, SILENT_AUDIO_CHECK_INTERVAL_MS)

    return () => {
      clearInterval(pollTimer)
      if (releaseTimer) clearTimeout(releaseTimer)
      video.removeAttribute('src')
      video.load()
    }
  }, [titleKey, reloadTick])

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
      {error && <div className="login-error" style={{ padding: '6px 16px' }}>{error}</div>}
    </div>
  )
}

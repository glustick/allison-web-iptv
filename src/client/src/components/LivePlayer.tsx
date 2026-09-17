import { useEffect, useRef, useState, type JSX } from 'react'
import Hls from 'hls.js'
import { useTranscodeFallback } from '../lib/transcodeFallback'
import { streamNeedsTranscode } from '../lib/transcodeHints'
import { sniffStreamKind } from '../lib/streamKind'
import { useSessionExpired } from '../lib/sessionWatch'
import { isPlayheadAtBufferEnd, liveRecoveryActions } from '../lib/liveStreamRecovery'
import { canDecodeAudioCodec } from '../lib/audioCodecSupport'
import { TrackControls, type PlayerTrack } from './TrackControls'

// Matches the desktop app's own Player.tsx recovery tuning (see its ROADMAP): a fatal
// NETWORK_ERROR or MEDIA_ERROR from hls.js is often transient (a brief network blip, a
// momentary decode hiccup) and resolves on retry — ported here because this player previously
// just displayed an error and stalled on any fatal event, requiring a full page reload to
// recover, unlike the desktop app which self-heals and was confirmed live not to exhibit the
// same freezing.
const MAX_NETWORK_RETRIES = 4
const NETWORK_RETRY_DELAY_MS = 2000
const MAX_MEDIA_ERROR_RECOVERIES = 3
const ERROR_RESET_AFTER_MS = 15000

// How often the backgrounding-recovery watchdog below re-checks the stream. Interval clamping
// while the page is suspended is fine — the point is to catch the wedge shortly *after* the
// page becomes active again, not during suspension (see lib/liveStreamRecovery.ts).
const RECOVERY_CHECK_INTERVAL_MS = 15_000

// Live TV's own silent-audio detection (see the effect below). A Dolby (E-AC-3/AC-3) audio
// track isn't decodable by most browsers, and unlike VOD nothing guarantees hls.js raises an
// error for it: the fragment can append with the audio silently dropped, leaving a perfectly
// smooth picture with no sound and no event to react to — the reported "Sky News FHD has no
// audio". Polling the element's own decoded-byte counters catches that shape.
const SILENT_AUDIO_CHECK_INTERVAL_MS = 1000
const SILENT_AUDIO_SILENT_TICKS = 3
// Two concurrent requests for one stream (this one, plus ffmpeg about to open it) can trip a
// single-connection provider, so the element is detached and given a moment before transcode.
const CONNECTION_RELEASE_DELAY_MS = 2000

// Chromium's real, long-standing decoded-byte counters — absent elsewhere, which is why every
// check below keys off them being present rather than treating a missing property as silence.
interface ChromiumVideoElement extends HTMLVideoElement {
  webkitVideoDecodedByteCount?: number
  webkitAudioDecodedByteCount?: number
}

// Live TV only: this is the hls.js-attached player, matching the desktop app's own split
// between Player.tsx's live path (always .m3u8, always hls.js) and its VOD/series path (a
// plain native <video src>, see NativeVideoPlayer.tsx) — the two need genuinely different
// audio-codec-fallback detection (an hls.js ERROR event plus the decoded-audio poll below,
// versus a plain native element's own decoded-byte polling), so they're kept as separate
// components rather than one that branches.
export function LivePlayer({ url, channelKey }: { url: string; channelKey: string }): JSX.Element {
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
  const [audioTracks, setAudioTracks] = useState<PlayerTrack[]>([])
  const [subtitleTracks, setSubtitleTracks] = useState<PlayerTrack[]>([])
  const [audioTrack, setAudioTrack] = useState(-1)
  const [subtitleTrack, setSubtitleTrack] = useState(-1)
  const { getSourceUrl, tryFallback, tryFallbackForSilentAudio, reset, beginRun, hasSession, restartFallback } = useTranscodeFallback()
  // Recovery ladder state, deliberately on the component (not in the effect): the effect is
  // torn down and rebuilt by every reload tick, and an attempt counter that reset with it
  // would loop forever instead of ever escalating.
  const reloadAttemptsRef = useRef(0)
  const lastReloadAtRef = useRef(0)

  // A genuinely different channel resets the fallback (and stops any in-flight ffmpeg
  // session) — an internal reload (reloadTick bumping after a successful fallback) must not,
  // or the freshly-started transcode session would immediately be torn down again.
  useEffect(() => {
    reset()
    reloadAttemptsRef.current = 0
  }, [channelKey, reset])

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    setError(null)
    beginRun()
    // Known to need converting (lib/transcodeHints.ts): skip the direct attempt rather than playing
    if (streamNeedsTranscode(url)) {
      tryFallbackForSilentAudio(url, false, () => setReloadTick((t) => t + 1), (message) => setError(message))
      return
    }
    const sourceUrl = getSourceUrl(url)
    let hls: Hls | null = null
    let networkRetryCount = 0
    let mediaErrorRecoveryCount = 0
    let errorResetTimer: ReturnType<typeof setTimeout> | null = null
    let networkRetryTimer: ReturnType<typeof setTimeout> | null = null

    const handleWaiting = (): void => {
      // Still recovering — don't let a stretch of genuinely uninterrupted playback earlier
      // forgive an error that's actively recurring right now.
      if (errorResetTimer) {
        clearTimeout(errorResetTimer)
        errorResetTimer = null
      }
    }
    const handlePlaying = (): void => {
      // A stretch of real, uninterrupted playback means whatever caused an earlier media or
      // network error is very likely no longer happening — reset both recovery counts so a
      // later, unrelated blip gets its own full set of attempts instead of inheriting counts
      // left over from a problem that already resolved itself.
      if (errorResetTimer) clearTimeout(errorResetTimer)
      errorResetTimer = setTimeout(() => {
        mediaErrorRecoveryCount = 0
        networkRetryCount = 0
      }, ERROR_RESET_AFTER_MS)
    }
    video.addEventListener('waiting', handleWaiting)
    video.addEventListener('playing', handlePlaying)

    // Backgrounding recovery (see lib/liveStreamRecovery.ts): a suspended page stops hls.js's
    // live-refresh timer chain, and nothing restarts it on its own once the page is active
    // again — found live as a permanent, silent freeze. This watchdog notices a stream that
    // stopped receiving fragments while starved at its buffer end and restarts it: resume the
    // element if the browser auto-paused it, kick hls.startLoad(), and after two fruitless
    // kicks rebuild the source entirely via the same reload path the transcode fallback uses.
    let lastFragmentAt: number | null = null
    let kicksSinceLastFragment = 0
    let gaveUp = false
    // The effect closure would otherwise keep the `error` state from this render forever — the
    // watchdog needs to see fatal give-ups that happen later in this same effect's lifetime.
    let fatalErrorShown = false
    const recoveryTimer = setInterval(() => {
      if (!hls || gaveUp || fatalErrorShown) return
      const actions = liveRecoveryActions({
        now: Date.now(),
        lastFragmentAt,
        playheadAtBufferEnd: isPlayheadAtBufferEnd(video),
        hasFatalError: fatalErrorShown,
        ended: video.ended,
        kicksSinceLastFragment
      })
      if (actions.reloadSource) {
        gaveUp = true
        const attempt = reloadAttemptsRef.current + 1
        reloadAttemptsRef.current = attempt
        lastReloadAtRef.current = Date.now()
        console.warn(`[player] live stream stalled; recovery attempt ${attempt}`)
        // Escalation, because a plain reload can only fix a wedged *player*, not a wedged
        // *stream*: 1) rebuild the source; 2) switch engines (start a transcode, or replace a
        // dead transcode session — reloading the same dead session id just re-freezes);
        // 3) stop pretending and offer a visible retry instead of a silent frozen frame.
        if (attempt === 2) {
          const escalated = hasSession()
            ? restartFallback(
                url,
                () => setReloadTick((t) => t + 1),
                (message) => {
                  fatalErrorShown = true
                  setError(`Playback stalled and restarting the transcode failed: ${message}`)
                }
              )
            : false
          if (escalated) return
        }
        if (attempt >= 3) {
          fatalErrorShown = true
          setError(
            'This stream stopped responding and could not be recovered automatically. Press Retry to start it again.'
          )
          return
        }
        setReloadTick((t) => t + 1)
        return
      }
      if (actions.kickLoader) {
        console.warn('[player] live loading stalled after backgrounding; restarting hls loader')
        kicksSinceLastFragment += 1
        hls.startLoad()
      }
      if (actions.resumePlayback && video.paused) {
        video.play().catch(() => {})
      }
    }, RECOVERY_CHECK_INTERVAL_MS)
    // Silent-audio watchdog: fires when the browser is playing video without ever decoding
    // audio — either because the level carries a codec we know this browser can't decode, or
    // (Chromium) because no audio bytes have come out after several seconds of real playback.
    const isTypeSupported = (mimeType: string): boolean =>
      typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported(mimeType)
    let silentFallbackStarted = false
    let releaseTimer: ReturnType<typeof setTimeout> | null = null
    let consecutiveSilentTicks = 0
    let everDecodedVideo = false
    const startSilentAudioFallback = (): void => {
      if (silentFallbackStarted || gaveUp || fatalErrorShown) return
      silentFallbackStarted = true
      clearInterval(silentAudioTimer)
      video.pause()
      video.removeAttribute('src')
      video.load()
      releaseTimer = setTimeout(() => {
        tryFallbackForSilentAudio(
          url,
          // Live TV is not a VOD file: false is what gives ffmpeg the live demuxer/reconnect flags
          // and live's own start deadline.
          false,
          () => setReloadTick((t) => t + 1),
          (message) => {
            fatalErrorShown = true
            setError(`Audio codec not supported by this player, and automatic transcoding failed: ${message}`)
          }
        )
      }, CONNECTION_RELEASE_DELAY_MS)
    }
    const silentAudioTimer = setInterval(() => {
      if (silentFallbackStarted || gaveUp || fatalErrorShown) return
      if (video.paused || video.muted || video.readyState < 2) return
      const probe = video as ChromiumVideoElement
      if (probe.webkitAudioDecodedByteCount === undefined) return
      const videoBytes = probe.webkitVideoDecodedByteCount ?? 0
      const audioBytes = probe.webkitAudioDecodedByteCount
      if (videoBytes > 0) everDecodedVideo = true
      consecutiveSilentTicks = videoBytes > 0 && audioBytes === 0 ? consecutiveSilentTicks + 1 : 0
      if (consecutiveSilentTicks >= SILENT_AUDIO_SILENT_TICKS && video.currentTime > 2) {
        console.warn('[player] playing with no decoded audio; switching to the transcode path')
        startSilentAudioFallback()
      }
    }, SILENT_AUDIO_CHECK_INTERVAL_MS)

    const noteFragmentActivity = (): void => {
      lastFragmentAt = Date.now()
      kicksSinceLastFragment = 0
      // Fragments after a recovery attempt mean it actually worked — give a later, unrelated
      // stall its own full ladder instead of inheriting this one's count.
      if (reloadAttemptsRef.current > 0 && Date.now() - lastReloadAtRef.current > 30_000) {
        reloadAttemptsRef.current = 0
      }
    }

    if (Hls.isSupported()) {
      hls = new Hls({
        // Fixes a real, previously-confirmed bug (see the sibling AllisonIPTV desktop app's own
        // ROADMAP, v0.7.51): some channels' live playlists don't refresh with a segment-sequence
        // timeline hls.js's own reconciliation can consistently agree with, and since this kind
        // of provider serves one flat rendition per channel (no alternate quality level to fall
        // back to instead), hls.js immediately escalates that from a non-fatal event straight to
        // a fatal "levelParsingError" — confirmed live to happen on this exact account/channel.
        // This option tolerates precisely that class of reconciliation inconsistency without
        // also silencing a genuinely empty/malformed playlist (which still raises its own
        // separate, ungated error).
        ignorePlaylistParsingErrors: true
      })
      const instance = hls
      hlsRef.current = instance
      instance.loadSource(sourceUrl)
      instance.attachMedia(video)
      instance.on(Hls.Events.FRAG_BUFFERED, noteFragmentActivity)
      instance.on(Hls.Events.MANIFEST_PARSED, () => {
        // Proactive rather than waiting for an error that may never come: if the stream's audio
        // is a codec this browser cannot decode, switch to the transcode path immediately
        // instead of showing a silent picture.
        const undecodable = (instance.levels ?? []).find(
          (level) => level.audioCodec && !canDecodeAudioCodec(level.audioCodec, isTypeSupported)
        )
        if (undecodable) {
          console.warn(`[player] stream audio is ${undecodable.audioCodec}, not decodable here; transcoding`)
          startSilentAudioFallback()
        }
      })
      instance.on(Hls.Events.AUDIO_TRACKS_UPDATED, (_event, data) => {
        setAudioTracks(data.audioTracks.map((track, index) => ({
          index,
          name: track.name,
          lang: track.lang,
          default: track.default
        })))
        setAudioTrack(instance.audioTrack)
      })
      instance.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, (_event, data) => {
        setSubtitleTracks(data.subtitleTracks.map((track, index) => ({
          index,
          name: track.name,
          lang: track.lang,
          default: track.default
        })))
        setSubtitleTrack(instance.subtitleTrack)
      })
      instance.on(Hls.Events.ERROR, (_event, data) => {
        if (
          tryFallback(
            data,
            url,
            () => setReloadTick((t) => t + 1),
            (message) => {
              fatalErrorShown = true
              setError(`Audio codec not supported by this player, and automatic transcoding failed: ${message}`)
            }
          )
        ) {
          return
        }
        if (!data.fatal) return
        console.error('[player] fatal hls error', data.type, data.details)
        switch (data.type) {
          case Hls.ErrorTypes.NETWORK_ERROR:
            networkRetryCount += 1
            if (networkRetryCount <= MAX_NETWORK_RETRIES) {
              if (networkRetryTimer) clearTimeout(networkRetryTimer)
              networkRetryTimer = setTimeout(() => instance.startLoad(), NETWORK_RETRY_DELAY_MS)
            } else {
              fatalErrorShown = true
              setError(`Playback error: ${data.details} (gave up after ${MAX_NETWORK_RETRIES} retries)`)
              instance.destroy()
            }
            break
          case Hls.ErrorTypes.MEDIA_ERROR:
            // recoverMediaError() alone has no retry cap, so a persistent (non-transient) media
            // error recovers, immediately re-fails, and recovers again in a tight loop —
            // escalate instead of looping forever, matching hls.js's own recommended pattern.
            mediaErrorRecoveryCount += 1
            if (mediaErrorRecoveryCount > MAX_MEDIA_ERROR_RECOVERIES) {
              fatalErrorShown = true
              setError(`Playback error: ${data.details} (gave up after ${MAX_MEDIA_ERROR_RECOVERIES} recovery attempts)`)
              instance.destroy()
            } else if (mediaErrorRecoveryCount === 2) {
              instance.swapAudioCodec()
              instance.recoverMediaError()
            } else {
              instance.recoverMediaError()
            }
            break
          default:
            fatalErrorShown = true
            setError(`Playback error: ${data.details}`)
            instance.destroy()
        }
      })
    } else {
      video.src = sourceUrl
    }
    video.play().catch(() => {})
    return () => {
      clearInterval(recoveryTimer)
      video.removeEventListener('waiting', handleWaiting)
      video.removeEventListener('playing', handlePlaying)
      if (errorResetTimer) clearTimeout(errorResetTimer)
      if (networkRetryTimer) clearTimeout(networkRetryTimer)
      clearInterval(silentAudioTimer)
      if (releaseTimer) clearTimeout(releaseTimer)
      hls?.destroy()
      hlsRef.current = null
      setAudioTracks([])
      setSubtitleTracks([])
      setAudioTrack(-1)
      setSubtitleTrack(-1)
      video.removeAttribute('src')
      video.load()
    }
  }, [channelKey, reloadTick])

  // Some channels are not HLS at all: the provider answers the playlist URL with raw MPEG-TS,
  // which hls.js cannot parse — and because this player deliberately ignores playlist *parsing*
  // errors (for a provider that shuffles segment sequences), even that failure is swallowed and the
  // player waits forever for levels that never arrive. Measured on this account: Sky News FHD and HD
  // both return ~3.8 MB of TS where a playlist should be. Check the first bytes and route TS to the
  // transcoder, which is the rule the rest of the app already follows — and which also remembers the
  // channel, so the next play goes straight there.
  useEffect(() => {
    if (url.startsWith('/__transcode/')) return   // already the transcoder's own output
    if (streamNeedsTranscode(url)) return          // known already: the hint path deals with it
    let cancelled = false
    void (async () => {
      const kind = await sniffStreamKind(url)
      if (cancelled || kind !== 'mpegts') return
      console.warn('[player] stream is raw MPEG-TS, not HLS; routing it through the transcoder')
      tryFallbackForSilentAudio(url, false, () => setReloadTick((t) => t + 1), (message) => setError(message))
    })()
    return () => { cancelled = true }
  }, [url, channelKey])

  // A player-level retry can never succeed if the login itself ended (server restart, expired
  // session) — in that case send the user through sign-in rather than looping on a dead source.
  async function retryPlayback(): Promise<void> {
    try {
      const res = await fetch('/api/auth/state')
      const data = res.ok ? ((await res.json()) as { authenticated?: boolean }) : null
      if (!data?.authenticated) {
        window.location.reload()
        return
      }
    } catch {
      // Offline — fall through and retry the player anyway.
    }
    reloadAttemptsRef.current = 0
    setError(null)
    setReloadTick((t) => t + 1)
  }

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
      {!sessionExpired && error && (
        <div className="player-error">
          <span>{error}</span>
          <button type="button" className="admin-small-btn" onClick={() => void retryPlayback()}>
            Retry
          </button>
        </div>
      )}
    </div>
  )
}

import { useEffect, useRef, useState, type JSX } from 'react'
import Hls from 'hls.js'
import { stallRecoveryShape, useTranscodeFallback } from '../lib/transcodeFallback'
import { noteStreamNeedsTranscode, streamNeedsTranscode, streamNeedsVideoTranscode } from '../lib/transcodeHints'
import { prefersNativePlayback } from '../lib/nativePlayback'
import { sniffStreamKind } from '../lib/streamKind'
import { probeAudioTracks } from '../lib/audioTrackProbe'
import { useSessionExpired } from '../lib/sessionWatch'
import { isPlayheadAtBufferEnd, liveRecoveryActions } from '../lib/liveStreamRecovery'
import { canDecodeAudioCodec } from '../lib/audioCodecSupport'
import { loadPlayerPrefs, pickTrackIndex, savePlayerPrefs, trackKey } from '../lib/playerPrefs'
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
  // Applied once per stream: hls.js re-fires the track events on reloads, and re-applying would
  // fight a choice the viewer made a moment ago.
  const audioPrefAppliedRef = useRef(false)
  const subtitlePrefAppliedRef = useRef(false)
  const [subtitleTrack, setSubtitleTrack] = useState(-1)
  const { getSourceUrl, tryFallback, tryFallbackForSilentAudio, reset, beginRun, hasSession, restartFallback, escalateToVideoTranscode, hasTriedVideoTranscode } = useTranscodeFallback()
  // Recovery ladder state, deliberately on the component (not in the effect): the effect is
  // torn down and rebuilt by every reload tick, and an attempt counter that reset with it
  // would loop forever instead of ever escalating.
  const reloadAttemptsRef = useRef(0)
  const lastReloadAtRef = useRef(0)
  // Which engine this run uses, and whether native has had its chance. Native wherever the browser
  // has its own HLS pipeline (Safari) — the route a native player takes, and the one that plays the
  // provider's container as-is with hardware decode instead of remuxing everything for MSE (see
  // lib/nativePlayback.ts). hls.js remains the engine for browsers without one, and a native failure
  // re-attaches with hls.js once, so the worst case is the old behaviour a retry later.
  const engineRef = useRef<'native' | 'hls' | null>(null)
  const nativeFailedRef = useRef(false)

  // A genuinely different channel resets the fallback (and stops any in-flight ffmpeg
  // session) — an internal reload (reloadTick bumping after a successful fallback) must not,
  // or the freshly-started transcode session would immediately be torn down again.
  useEffect(() => {
    reset()
    reloadAttemptsRef.current = 0
    engineRef.current = null
    nativeFailedRef.current = false
  }, [channelKey, reset])

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    setError(null)
    beginRun()
    // The engine has to be known before the hint below is read, since one of those hints is a
    // statement about MSE rather than about the stream.
    if (engineRef.current === null) {
      engineRef.current = prefersNativePlayback((type) => video.canPlayType(type)) ? 'native' : 'hls'
    }
    // Known to need converting (lib/transcodeHints.ts): skip the direct attempt rather than playing
    // nothing first — but only when there is not already a transcoded stream to play. Once the
    // fallback has produced a URL, this has to fall through and hand *that* to the player; returning
    // here regardless is what left a freshly started transcode unfetched and the screen black.
    if (streamNeedsTranscode(url) && getSourceUrl(url) === url) {
      // A channel that only played once its video was re-encoded goes straight to that tier on the
      // next play, rather than paying for a copy session this browser will abandon. Only under
      // hls.js, though: that memory was learned through MSE, and the native pipeline answers a
      // different question — forcing a re-encode because hls.js once struggled would downscale a
      // channel the browser can play untouched.
      tryFallbackForSilentAudio(
        url,
        false,
        () => setReloadTick((t) => t + 1),
        (message) => setError(message),
        engineRef.current === 'hls' && streamNeedsVideoTranscode(url)
      )
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
    const runStartedAt = Date.now()
    // The effect closure would otherwise keep the `error` state from this render forever — the
    // watchdog needs to see fatal give-ups that happen later in this same effect's lifetime.
    let fatalErrorShown = false
// stalls are counted per stream; two of them mean this one cannot be relayed reliably
let stallCount = 0
    const recoveryTimer = setInterval(() => {
      if (!hls || gaveUp || fatalErrorShown) return
      const actions = liveRecoveryActions({
        now: Date.now(),
        lastFragmentAt,
        runStartedAt,
        playheadAtBufferEnd: isPlayheadAtBufferEnd(video),
        hasFatalError: fatalErrorShown,
        ended: video.ended,
        paused: video.paused,
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
        //
        // On a transcode session, skip straight to replacing the session (v0.28's own lesson,
        // relearned live on the club channels on 2026-09-19): a plain reload re-attaches the
        // same dead session id and provably re-freezes, so spending attempt 1 on it just adds
        // a doomed 60s-staleness cycle before the restart that was always going to be needed.
        //
        // Which shape to rebuild in is decided purely (and unit-tested) in stallRecoveryShape:
        // v0.46.1 taught a stalled stream-copy session to escalate to the re-encode tier, and
        // v0.46.2 gives a *direct* stream the same escape every other reload path in this app
        // already has — once its reloads are spent it is converted, not declared unrecoverable.
        const shape = stallRecoveryShape({
          onTranscodeSession: hasSession(),
          videoTranscodeTried: hasTriedVideoTranscode(),
          reloadAttempts: attempt
        })
        if (shape === 'video-transcode') {
          const escalated = escalateToVideoTranscode(
            url,
            () => setReloadTick((t) => t + 1),
            (message) => {
              fatalErrorShown = true
              setError(`Playback stalled and converting the channel failed: ${message}`)
            }
          )
          if (escalated) return
        } else if (shape === 'session') {
          const restarted = restartFallback(
            url,
            () => setReloadTick((t) => t + 1),
            (message) => {
              fatalErrorShown = true
              setError(`Playback stalled and restarting the transcode failed: ${message}`)
            }
          )
          if (restarted) return
        } else if (shape === 'convert') {
          // The last rung for the provider's own stream, when every reload has already failed:
          // convert it — the cheap copy tier, exactly as the refused-segment and buffer-stall paths
          // do — rather than showing the terminal error. Nothing here claims the video is
          // undecodable, so a session that then stalls escalates one rung up by itself.
          const converted = tryFallbackForSilentAudio(
            url,
            false,
            () => setReloadTick((t) => t + 1),
            (message) => setError(message)
          )
          if (converted) return
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

    const onNativeError = (): void => {
      // One retry with hls.js for a browser whose own pipeline refused the stream — not a loop. A
      // stream that defeats both engines is a stream problem, and the ladder above is what handles it.
      if (nativeFailedRef.current) return
      nativeFailedRef.current = true
      engineRef.current = 'hls'
      console.warn('[player] native HLS playback failed; re-attaching with hls.js')
      setReloadTick((t) => t + 1)
    }

    if (engineRef.current === 'native') {
      // The whole point of native playback: hand the provider's playlist to the browser's own HLS
      // implementation. Nothing is demuxed by JavaScript, nothing is re-encapsulated for MSE, and
      // nothing needs transcoding to fit a codec MSE will accept — which is exactly why a native
      // player shows these channels untouched, at their own resolution.
      //
      // The watchdog and the silent-audio poll below deliberately do nothing here: both are
      // hls.js/MSE instrumentation (`!hls` short-circuits the one, and the decoded-byte counters it
      // reads are Chromium-only), and neither has anything to add to a pipeline the browser runs
      // itself. A native stream that stalls is handled by the browser, and by the error fallback.
      video.addEventListener('error', onNativeError)
      video.src = sourceUrl
      video.play().catch(() => {})
    } else if (Hls.isSupported()) {
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
        // Apply the remembered choice once per stream. hls.js re-fires these events on reloads, and
        // re-applying on every one would fight a choice the viewer made a moment ago.
        if (!audioPrefAppliedRef.current) {
          audioPrefAppliedRef.current = true
          const preferred = pickTrackIndex(
            data.audioTracks.map((track, index) => ({ index, name: track.name, lang: track.lang, default: track.default })),
            loadPlayerPrefs().audioTrack
          )
          if (preferred !== null) instance.audioTrack = preferred
        }
        setAudioTrack(instance.audioTrack)
      })
      instance.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, (_event, data) => {
        setSubtitleTracks(data.subtitleTracks.map((track, index) => ({
          index,
          name: track.name,
          lang: track.lang,
          default: track.default
        })))
        if (!subtitlePrefAppliedRef.current) {
          subtitlePrefAppliedRef.current = true
          const saved = loadPlayerPrefs()
          if (saved.subtitlesOff) instance.subtitleTrack = -1
          else {
            const preferred = pickTrackIndex(
              data.subtitleTracks.map((track, index) => ({ index, name: track.name, lang: track.lang, default: track.default })),
              saved.subtitleTrack
            )
            if (preferred !== null) instance.subtitleTrack = preferred
          }
        }
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
        // A stall is not an error: hls.js raises it as a non-fatal warning, which is why a frozen
        // picture can leave an entirely empty console — no failed request, nothing red. This is the
        // failure the heavy club channels show: the app serves their segments correctly (verified from
        // the server: no provider errors, the browser reporting it is playing) and the player simply
        // stops receiving usable data. Watching for an HTTP status, as v0.42.1 did, can never catch it.
        //
        // Converted only after two stalls. A single one is usually a transient hiccup, and converting a
        // healthy channel would remember it as needing conversion for ever.
        if (!data.fatal && data.details === Hls.ErrorDetails.BUFFER_STALLED_ERROR && !url.startsWith('/__transcode/')) {
          stallCount += 1
          if (stallCount >= 2) {
            noteStreamNeedsTranscode(url)
            setError(null)
            instance.destroy()
            tryFallbackForSilentAudio(url, false, () => setReloadTick((t) => t + 1), (message) => setError(message))
            return
          }
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
              // A silent provider is the common failure here, and it reaches the player as a 502/504
              // from this app's own relay. Say that, rather than hls.js's internal error name — the
              // movie player has done exactly this since v0.31.0; the live one had not.
              const code = (data as { response?: { code?: number } }).response?.code
              // A refused segment (400/403) means the provider's signed URL expired before we could use
              // it — a property of relaying a heavy stream, where the segment itself takes long enough
              // that the next one's signature has gone. Measured on the 6 Mbps club channels: the first
              // segment relays fine and the rest of the same playlist is refused.
              //
              // Such a channel cannot be relayed reliably, so convert it instead, and remember it so the
              // next play goes straight there. The transcoder follows the playlist itself and never
              // reuses a cached URL, which is why it does not have this problem. (The fallback refuses
              // /__transcode/ URLs, so this cannot loop.)
              if (code === 400 || code === 403) {
                noteStreamNeedsTranscode(url)
                setError(null)
                instance.destroy()
                tryFallbackForSilentAudio(url, false, () => setReloadTick((t) => t + 1), (message) => setError(message))
                break
              }
              // A session playlist that exhausts its network retries is a dead transcode session
              // (ffmpeg gone or wedged — measured live: killing ffmpeg produces exactly five
              // levelLoadErrors then this terminal state). Replaying the same session id can
              // only re-freeze (v0.28's own lesson), so replace the session outright instead of
              // erroring — the same move the recovery ladder makes, taken at the moment of
              // failure rather than three watchdog cycles later.
              if (hasSession()) {
                console.warn('[player] transcode session failed its network retries; replacing the session')
                setError(null)
                instance.destroy()
                restartFallback(
                  url,
                  () => setReloadTick((t) => t + 1),
                  (message) => {
                    fatalErrorShown = true
                    setError(`Playback stalled and restarting the transcode failed: ${message}`)
                  }
                )
                break
              }
              setError(
                code === 502 || code === 504
                  ? 'The provider is not responding — it may be down. Try again in a few minutes.'
                  : `Playback error: ${data.details} (gave up after ${MAX_NETWORK_RETRIES} retries)`
              )
              instance.destroy()
            }
            break
          case Hls.ErrorTypes.MEDIA_ERROR:
            // recoverMediaError() alone has no retry cap, so a persistent (non-transient) media
            // error recovers, immediately re-fails, and recovers again in a tight loop —
            // escalate instead of looping forever, matching hls.js's own recommended pattern.
            mediaErrorRecoveryCount += 1
            if (mediaErrorRecoveryCount > MAX_MEDIA_ERROR_RECOVERIES) {
              // The recoveries only ever fix transient decode hiccups. A stream that exhausts
              // all of them is one the decoder or hls.js's remuxer genuinely cannot cope with —
              // measured on the heavy club channels (1080p50 at ~6 Mbps): served correctly
              // through this app's own relay (200, video/mp2t, first byte 0x47 — real MPEG-TS,
              // not an error body, not truncated) and still fatally media-erroring. Hand it to
              // the transcoder, which re-encodes to 25 fps H.264 — the shape every channel that
              // already plays uses — and note the hint so the next play converts before playing
              // (the load-time check at the top of this effect). The fallback refuses to convert
              // a run that already converted, so this cannot loop; arriving here *with* a
              // session means transcoding itself has failed, and that is the end of the road.
              if (!hasSession()) {
                noteStreamNeedsTranscode(url)
                setError(null)
                instance.destroy()
                tryFallbackForSilentAudio(url, false, () => setReloadTick((t) => t + 1), (message) => setError(message))
                break
              }
              // Already on the transcoder's output and still unable to decode: this is the
              // HEVC-incapable browser — measured on this project's own test machine, a Chromium
              // build that answers isTypeSupported(hvc1) → true and then fails the actual append
              // (mediaSourceRequiresReset). The session's video is a stream-copy of source HEVC, so
              // nothing about the session is wrong; only a real H.264 re-encode can help. Escalate
              // to that tier once before giving up.
              if (escalateToVideoTranscode(url, () => setReloadTick((t) => t + 1), (message) => setError(message))) {
                setError(null)
                instance.destroy()
                break
              }
              fatalErrorShown = true
              setError('This channel cannot be decoded on this device, and automatic transcoding failed.')
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
      video.removeEventListener('error', onNativeError)
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

  // Safari cannot run the silent-audio fallback at all: it is driven by webkitAudioDecodedByteCount,
  // which exists only in Chromium. An E-AC-3-first channel (Sky Atlantic, Sky One) therefore plays
  // silently there forever while Chrome switches to the transcode — which is why this looked like a
  // channel-specific mystery. Ask the server what the stream actually carries and decide from that,
  // rather than from a counter only one browser family provides. The transcoder re-encodes to AAC
  // whatever the source, so once it starts the audio is audible.
  useEffect(() => {
    if (url.startsWith('/__transcode/')) return
    if (streamNeedsTranscode(url)) return
    // Under native playback the browser decodes the audio itself, and it decodes considerably more
    // than MSE does — Safari plays AC-3 and E-AC-3 natively. Asking MSE's opinion here would
    // transcode a channel whose audio the native pipeline handles perfectly, which is the opposite
    // of the point.
    if (engineRef.current === 'native') return
    let cancelled = false
    void (async () => {
      const tracks = await probeAudioTracks(url)
      if (cancelled || tracks.length === 0) return
      // this effect is a sibling of the hls one, so it cannot see that effect's local probe
      const decodeProbe = (mimeType: string): boolean =>
        typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported(mimeType)
      if (canDecodeAudioCodec(tracks[0].codec, decodeProbe)) return
      console.warn(`[player] first audio track is ${tracks[0].codec}, which this browser cannot decode; transcoding`)
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
          const chosen = audioTracks.find((track) => track.index === index)
          if (chosen) savePlayerPrefs({ ...loadPlayerPrefs(), audioTrack: trackKey(chosen) })
        }}
        subtitleTracks={subtitleTracks}
        subtitleTrack={subtitleTrack}
        onSubtitleChange={(index) => {
          setSubtitleTrack(index)
          if (hlsRef.current) hlsRef.current.subtitleTrack = index
          const chosen = subtitleTracks.find((track) => track.index === index)
          savePlayerPrefs({
            ...loadPlayerPrefs(),
            subtitleTrack: chosen ? trackKey(chosen) : null,
            subtitlesOff: index < 0
          })
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

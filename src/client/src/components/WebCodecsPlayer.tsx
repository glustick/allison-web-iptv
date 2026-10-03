import { useEffect, useRef, useState, type JSX } from 'react'
import Hls from 'hls.js'
import { runWebCodecsVideo, playingWallMsFromFrags, type StampedFragment, type WebCodecsVideoStats } from '../lib/webCodecsVideo'
import { verdictIsUsable, loadVerdict } from '../lib/decodeGate'
import { newSessionId } from '../lib/sessionId'

// The client-side engine, in the player. The picture is decoded in this browser (WebCodecs, the
// device's own GPU — gated on the decode verdict this device saved for itself) straight off the
// provider's segments; the sound rides the audio-only session (v0.65.0), played by a <video>
// element underneath the canvas whose controls stay real — the canvas paints pixels only and lets
// pointer events pass through to them.
//
// Synchronisation: the video presents against the AUDIO's wall-clock instant, derived from the
// audio session's PROGRAM-DATE-TIME stamps (each fragment hls.js plays carries one), mapped onto
// the video's own PDT stamps. Both renditions describe the same source, so the same wall instant
// names the same content instant — no shared timeline is negotiated anywhere, the streams just
// agree because their playlists both say what wall time the content is.

export function WebCodecsPlayer({
  url,
  onNotice
}: {
  url: string
  onNotice?: (message: string | null) => void
}): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const audioVideoRef = useRef<HTMLVideoElement | null>(null)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const [stats, setStats] = useState<WebCodecsVideoStats | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  // Audio-side notices win over the engine's generic "no audio clock" line: the engine speaks
  // once at startup, while the audio failure arrives later — the specific cause must not be
  // clobbered by the generic symptom (the 2026-10-02 hunt's lesson).
  const [audioNotice, setAudioNotice] = useState<string | null>(null)
  // Sound is attempted outright: Chrome allows unmuted autoplay after a recent interaction or with
  // media engagement on the site — both true for the person using this app — so the normal case is
  // sound with no button at all. The chip appears only when the refusal is real (activation window
  // closed, no engagement), and the clock never waits on any of this (v0.66.4: buffered fragments).
  const [muted, setMuted] = useState(false)

  useEffect(() => {
    const canvas = canvasRef.current
    const audioVideo = audioVideoRef.current
    if (!canvas || !audioVideo) return
    if (!verdictIsUsable(loadVerdict())) {
      setError('this device has no usable client-decode verdict — run the check in Admin → System')
      return
    }

    // The controls' own fullscreen button fullscreens the *video element* — the canvas would stay
    // behind on the page. Redirect it to the wrapper (canvas + controls together). The guard makes
    // the redirect's own change event a no-op.
    // First interaction anywhere on the page unmutes the sound (and nudges play, in case even the
    // muted start was refused).
    const unmute = (): void => {
      audioVideo.muted = false
      setMuted(false)
      void audioVideo.play().catch(() => {})
    }
    document.addEventListener('pointerdown', unmute, { once: true })
    document.addEventListener('keydown', unmute, { once: true })
    audioVideo.addEventListener('volumechange', () => {
      if (!audioVideo.muted) setMuted(false)
    })

    const onFullscreenChange = (): void => {
      if (document.fullscreenElement === audioVideo) {
        void document
          .exitFullscreen()
          .then(() => wrapRef.current?.requestFullscreen().catch(() => {}))
          .catch(() => {})
      }
    }
    audioVideo.addEventListener('fullscreenchange', onFullscreenChange)

    let hls: Hls | null = null
    let engine: ReturnType<typeof runWebCodecsVideo> | null = null
    let sessionUrl: string | null = null
    let cancelled = false
    // The audio element's buffered fragments with their wall-clock stamps — the master clock's
    // raw material. FRAG_BUFFERED, not FRAG_CHANGED: buffering begins whether or not playback
    // has been allowed to start, and the clock must not wait for it.
    const frags: StampedFragment[] = []

    // Sound persistence (the 2026-10-02 no-audio finding): play() can be refused with an
    // AbortError when it races the load ('interrupted by a new load request') — not just the
    // NotAllowedError the chip handles — and a paused element means no sound AND a frozen
    // playhead, which starves the A/V clock too. Attempt unmuted once (engagement usually allows
    // it), then muted (always allowed), then keep nudging while paused until it sticks. Every
    // refusal's name lands in the console and the notice, so the next report is conclusive.
    function nudgePlay(stage: string): void {
      const el = audioVideoRef.current
      if (!el || el.paused !== true || el.ended) return
      void el.play().then(() => {
        setAudioNotice(null)
        if (el.muted) setMuted(true) // playing silent: the chip offers sound
      }).catch((err: unknown) => {
        const name = err instanceof DOMException ? err.name : String(err)
        console.warn(`[player] audio play() refused at ${stage}: ${name}`)
        setAudioNotice(`sound has not started — play() was refused (${name}); retrying when ready`)
        if (err instanceof DOMException && err.name === 'NotAllowedError' && !el.muted) {
          el.muted = true
          el.autoplay = true // the browser starts it the moment media is ready — no promise race
          setMuted(true)
        }
        // AbortError is a load interrupting the promise — the element's own autoplay (set below)
        // or the readiness nudge starts playback once media exists; play() promises are the wrong
        // tool for racing a load, and the operator's report (AbortError, retrying, forever) is
        // what proved it.
      })
    }
    // The readiness nudges: fire when media actually exists, which is the only moment play()
    // can succeed. canplay/playing cover the normal path; a slow-buffering day gets playing.
    for (const event of ['canplay', 'loadeddata', 'playing'] as const) {
      audioVideo.addEventListener(event, () => nudgePlay(event))
    }

    void (async () => {
      // The audio session first: it takes a moment to start, and the engine runs silent until it
      // is ready (then re-anchors to the clock, one notice, no lost picture).
      try {
        const res = await fetch('/api/transcode/start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          // newSessionId, never crypto.randomUUID: the raw API exists only in secure contexts,
          // and this deployment is reached over plain HTTP on the LAN — the v0.24.0 lesson,
          // repeated in new code (2026-10-01, ".48 chrome" test: video with no audio, no clock).
          body: JSON.stringify({ sourceUrl: url, isVod: false, sessionId: newSessionId(), audioOnly: true })
        })
        if (res.ok) {
          const data = (await res.json()) as { url?: string }
          sessionUrl = typeof data.url === 'string' ? data.url : null
        } else {
          setNotice(`the audio stream could not start (HTTP ${res.status}) — playing silent`)
        }
      } catch (err) {
        setNotice(`the audio stream could not start (${err instanceof Error ? err.message : String(err)}) — playing silent`)
      }
      if (cancelled) return

      if (sessionUrl && Hls.isSupported()) {
        hls = new Hls({
          // Sit roughly where the video loop joins (~2 segments back), so the two renditions of
          // the source start within a second or two of the same content instant.
          liveSyncDurationCount: 2
        })
        hls.on(Hls.Events.FRAG_BUFFERED, (_event, data) => {
          const frag = data.frag as { programDateTime?: number | null; rawProgramDateTime?: string | null; start: number }
          const pdt =
            typeof frag.programDateTime === 'number' && Number.isFinite(frag.programDateTime)
              ? frag.programDateTime
              : typeof frag.rawProgramDateTime === 'string' && Number.isFinite(Date.parse(frag.rawProgramDateTime))
                ? Date.parse(frag.rawProgramDateTime)
                : null
          if (pdt !== null) {
            frags.push({ startSec: frag.start, pdtMs: pdt })
            if (frags.length > 24) frags.shift() // the live window is 15; a little history is plenty
          }
        })
        hls.on(Hls.Events.ERROR, (_event, data) => {
          if (data.fatal) {
            // The audio died; the picture keeps going on wall time and says so. Not fatal to the
            // engine — a silent picture beats a dead channel. The buffered fragments' stamps stay
            // valid until the element runs past them.
            hls?.destroy()
            hls = null
            setAudioNotice('the audio stream failed — the picture continues without it')
          }
        })
        hls.loadSource(sessionUrl)
        hls.attachMedia(audioVideo)
        audioVideo.muted = false
        nudgePlay('initial')
      }

      engine = runWebCodecsVideo({
        source: url,
        canvas,
        masterWallMs: () => playingWallMsFromFrags(frags, audioVideo.currentTime),
        onStats: setStats,
        onNotice: (message) => {
          setNotice(message)
          onNotice?.(message)
        },
        onError: (message) => setError(message)
      })
    })()

    return () => {
      cancelled = true
      document.removeEventListener('pointerdown', unmute)
      document.removeEventListener('keydown', unmute)
      audioVideo.removeEventListener('fullscreenchange', onFullscreenChange)
      engine?.stop()
      hls?.destroy()
      if (sessionUrl) {
        // The audio session is a real ffmpeg on the server; say goodbye rather than waiting for
        // the idle reaper.
        const body = JSON.stringify({ sessionId: sessionUrl.split('/')[2] })
        try {
          navigator.sendBeacon?.('/api/transcode/stop', new Blob([body], { type: 'application/json' }))
        } catch {
          void fetch('/api/transcode/stop', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })
        }
      }
      audioVideo.pause()
      audioVideo.removeAttribute('src')
      audioVideo.load()
    }
  }, [url, onNotice])

  return (
    <div
      className="player-wrap"
      ref={wrapRef}
      onDoubleClick={() => wrapRef.current?.requestFullscreen?.().catch(() => {})}
      title="Double-click for fullscreen"
    >
      {/* The audio carrier: a video element with no picture to show, but real controls — volume,
          pause, the lot. The canvas above it paints the picture and lets every click through. With
          no video track the element has no intrinsic size, so it carries the player's shape
          itself — without this the whole player collapses to a small strip (".48 chrome" test). */}
      <video
        ref={audioVideoRef}
        controls
        playsInline
        autoPlay
        style={{ width: '100%', aspectRatio: '16 / 9', background: '#000' }}
      />
      <canvas
        ref={canvasRef}
        style={{
          position: 'absolute',
          // The bottom strip stays uncovered so the audio carrier's own controls (play, volume)
          // are VISIBLE — a canvas painted black over them left a paused stream with invisible
          // controls and no way to start the sound by hand (found 2026-10-02).
          top: 0,
          left: 0,
          right: 0,
          bottom: 44,
          width: '100%',
          height: 'calc(100% - 44px)',
          objectFit: 'contain',
          pointerEvents: 'none',
          background: '#000'
        }}
      />
      {muted && !error && (
        <button
          type="button"
          className="admin-small-btn"
          style={{ position: 'absolute', top: 8, left: 8, zIndex: 5 }}
          onClick={() => {
            audioVideoRef.current && (audioVideoRef.current.muted = false)
            setMuted(false)
            void audioVideoRef.current?.play().catch(() => {})
          }}
        >
          🔊 Tap for sound
        </button>
      )}
      {(audioNotice ?? notice) && (
        <div className="player-error" role="status" style={{ position: 'absolute', top: 8, left: 8 }}>
          <span>{audioNotice ?? notice}</span>
        </div>
      )}
      {error && (
        <div className="player-error">
          <span>{error}</span>
        </div>
      )}
      {stats && !error && (
        <div
          className="setup-hint"
          style={{ position: 'absolute', bottom: 52, right: 8, fontSize: '0.75rem', opacity: 0.85, whiteSpace: 'nowrap' }}
        >
          WebCodecs · {stats.codec ?? '…'} · drawn {stats.drawn}
          {stats.latencyBehindSec !== null ? ` · ${stats.latencyBehindSec.toFixed(1)}s behind` : ''}
          {stats.unclocked ? ' · no audio clock' : ' · in sync'}
        </div>
      )}
    </div>
  )
}

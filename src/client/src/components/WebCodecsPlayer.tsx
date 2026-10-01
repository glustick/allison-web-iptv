import { useEffect, useRef, useState, type JSX } from 'react'
import Hls from 'hls.js'
import { runWebCodecsVideo, type WebCodecsVideoStats } from '../lib/webCodecsVideo'
import { verdictIsUsable, loadVerdict } from '../lib/decodeGate'

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

  useEffect(() => {
    const canvas = canvasRef.current
    const audioVideo = audioVideoRef.current
    if (!canvas || !audioVideo) return
    if (!verdictIsUsable(loadVerdict())) {
      setError('this device has no usable client-decode verdict — run the check in Admin → System')
      return
    }

    let hls: Hls | null = null
    let engine: ReturnType<typeof runWebCodecsVideo> | null = null
    let sessionUrl: string | null = null
    let cancelled = false
    // The fragment the audio element is playing, with its wall-clock stamp — the master clock.
    let playingFrag: { pdtMs: number; startSec: number } | null = null

    void (async () => {
      // The audio session first: it takes a moment to start, and the engine runs silent until it
      // is ready (then re-anchors to the clock, one notice, no lost picture).
      try {
        const res = await fetch('/api/transcode/start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sourceUrl: url, isVod: false, sessionId: crypto.randomUUID(), audioOnly: true })
        })
        if (res.ok) {
          const data = (await res.json()) as { url?: string }
          sessionUrl = typeof data.url === 'string' ? data.url : null
        }
      } catch {
        // Silence, then — the engine's notice will say so.
      }
      if (cancelled) return

      if (sessionUrl && Hls.isSupported()) {
        hls = new Hls({
          // Sit roughly where the video loop joins (~2 segments back), so the two renditions of
          // the source start within a second or two of the same content instant.
          liveSyncDurationCount: 2
        })
        hls.on(Hls.Events.FRAG_CHANGED, (_event, data) => {
          const frag = data.frag as { programDateTime?: number | null; start: number }
          if (typeof frag.programDateTime === 'number' && Number.isFinite(frag.programDateTime)) {
            playingFrag = { pdtMs: frag.programDateTime, startSec: frag.start }
          }
        })
        hls.on(Hls.Events.ERROR, (_event, data) => {
          if (data.fatal) {
            // The audio died; the picture keeps going on wall time and says so. Not fatal to the
            // engine — a silent picture beats a dead channel.
            playingFrag = null
            hls?.destroy()
            hls = null
            setNotice('the audio stream failed — the picture continues without it')
          }
        })
        hls.loadSource(sessionUrl)
        hls.attachMedia(audioVideo)
        void audioVideo.play().catch(() => {})
      }

      engine = runWebCodecsVideo({
        source: url,
        canvas,
        masterWallMs: () => {
          if (!playingFrag) return null
          // The audio element's playhead inside the stamped fragment, in wall-clock ms.
          return playingFrag.pdtMs + (audioVideo.currentTime - playingFrag.startSec) * 1000
        },
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
          pause, the lot. The canvas above it paints the picture and lets every click through. */}
      <video ref={audioVideoRef} controls playsInline style={{ background: '#000' }} />
      <canvas
        ref={canvasRef}
        style={{
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
          objectFit: 'contain',
          pointerEvents: 'none',
          background: '#000'
        }}
      />
      {notice && (
        <div className="player-error" role="status" style={{ position: 'absolute', top: 8, left: 8 }}>
          <span>{notice}</span>
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
          style={{ position: 'absolute', bottom: 52, right: 8, fontSize: '0.75rem', opacity: 0.85 }}
        >
          WebCodecs · {stats.codec ?? '…'} · drawn {stats.drawn}
          {stats.latencyBehindSec !== null ? ` · ${stats.latencyBehindSec.toFixed(1)}s behind` : ''}
          {stats.unclocked ? ' · no audio clock' : ' · in sync'}
        </div>
      )}
    </div>
  )
}

import { useEffect, useRef, useState, type JSX } from 'react'
import {
  accessUnitIsKey,
  codecCandidates,
  extractHevcAccessUnits,
  hevcCodecStringFromAnnexB
} from '../lib/tsHevc'
import {
  INITIAL_LIVE_LOOP_STATE,
  parseLivePlaylist,
  planLiveLoop,
  segmentUrlBySequence,
  type LiveLoopFetch
} from '../lib/liveSegmentLoop'
import { appendPts, choosePresentation, presenterClockPts, PTS_HZ } from '../lib/framePresenter'
import { loadVerdict, verdictIsUsable } from '../lib/decodeGate'

// Enough 4K frames to ride out decode jitter, few enough that a stalled presenter cannot pile GPU
// memory into gigabytes — a 4K YUV frame is ~12 MB.
const QUEUE_CAP = 48

// The subset of WebCodecs the loop uses, structurally typed the way DecoderCheck types it — the
// client tsconfig carries DOM types, but not every browser build's WebCodecs matches the lib's shape,
// and the player must degrade to a sentence, not a crash.
interface DecoderInstance {
  configure: (config: Record<string, unknown>) => void
  decode: (chunk: unknown) => void
  flush: () => Promise<void>
  close: () => void
}
interface DecoderConstructor {
  new (init: {
    output: (frame: VideoFrameLike) => void
    error: (error: Error) => void
  }): DecoderInstance
  isConfigSupported?: (config: Record<string, unknown>) => Promise<{ supported?: boolean }>
}
interface VideoFrameLike {
  displayWidth: number
  displayHeight: number
  timestamp: number
  close: () => void
}
type ChunkCtor = new (init: { type: 'key' | 'delta'; timestamp: number; data: Uint8Array }) => unknown

interface LoopStats {
  codec: string | null
  presentedFps: number
  decoded: number
  presented: number
  droppedLate: number
  droppedCap: number
  queued: number
  segments: number
  refusedRetried: number
  latencyBehindSec: number | null
  playlistStagnant: boolean
}

const IDLE_STATS: LoopStats = {
  codec: null,
  presentedFps: 0,
  decoded: 0,
  presented: 0,
  droppedLate: 0,
  droppedCap: 0,
  queued: 0,
  segments: 0,
  refusedRetried: 0,
  latencyBehindSec: null,
  playlistStagnant: false
}

/**
 * The client-side engine's live loop, run standalone — the exact video pipeline the player will use,
 * before it is wired into LivePlayer: poll the playlist, fetch new segments while their signatures
 * are young, demux with PTS, decode with WebCodecs, and present on a canvas paced by the frames'
 * own timestamps.
 *
 * **Video only, on purpose.** Audio stays on the server's path until this engine joins the player
 * (WebCodecs has no Dolby decoder, so audio arrives with the AAC session the player integration
 * brings). Running the loop here first is what proves the risky half — the loop, the pacing, the
 * continuity — where a bug costs a canvas, not a channel.
 */
export function ClientDecodeLoop(): JSX.Element {
  const [source, setSource] = useState('/api/stream/live/668.m3u8')
  const [running, setRunning] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [stats, setStats] = useState<LoopStats>(IDLE_STATS)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const runRef = useRef<{ abort: AbortController } | null>(null)

  useEffect(() => {
    // Unmount stops the loop the same way the button does.
    return () => {
      runRef.current?.abort.abort()
      runRef.current = null
    }
  }, [])

  function drawFrame(frame: VideoFrameLike, canvas: HTMLCanvasElement | null): void {
    if (!canvas) return
    // Draw at the size the canvas is actually displayed at, never the stream's own 3840x2160.
    // Measured 2026-10-01 on the 4K Main 10 channel: decode ran at ~8x realtime while only about
    // 13% of due frames got drawn — a full-resolution blit per frame into a 2D canvas starves
    // presentation all by itself. The browser scales the canvas element up visually; what this
    // surface proves is a moving picture, not eight million pixels per draw.
    const width = Math.max(160, Math.floor(canvas.clientWidth || frame.displayWidth))
    const height = Math.max(90, Math.round((width * frame.displayHeight) / Math.max(1, frame.displayWidth)))
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width
      canvas.height = height
    }
    canvas.getContext('2d')?.drawImage(frame as unknown as CanvasImageSource, 0, 0, width, height)
  }

  async function pickCodec(
    ctor: DecoderConstructor,
    firstUnit: Uint8Array
  ): Promise<{ codec: string; config: Record<string, unknown> } | null> {
    const candidates = codecCandidates(hevcCodecStringFromAnnexB(firstUnit))
    for (const codec of candidates) {
      const config = { codec, hardwareAcceleration: 'prefer-hardware' as const }
      try {
        const support = await ctor.isConfigSupported?.(config)
        if (support?.supported) return { codec, config }
      } catch {
        // Try the next candidate — a platform that throws on a string has still answered.
      }
    }
    return null
  }

  async function fetchSegmentBytes(
    url: string,
    signal: AbortSignal
  ): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; status: number }> {
    const res = await fetch(url, { signal })
    if (!res.ok) return { ok: false, status: res.status }
    return { ok: true, bytes: new Uint8Array(await res.arrayBuffer()) }
  }

  function start(): void {
    if (runRef.current) return
    void (async () => {
      // Narrowed once, up front — the closures below capture these as definite, not optional.
      const RawChunk = (globalThis as unknown as { EncodedVideoChunk?: ChunkCtor }).EncodedVideoChunk
      const RawCtor = (globalThis as unknown as { VideoDecoder?: DecoderConstructor }).VideoDecoder
      if (!RawCtor || !RawChunk || typeof RawCtor.isConfigSupported !== 'function') {
        setStatus('this browser has no WebCodecs VideoDecoder — the client-side player cannot run here')
        return
      }
      const ctor: DecoderConstructor = RawCtor
      const Chunk: ChunkCtor = RawChunk
      if (!verdictIsUsable(loadVerdict())) {
        setStatus(
          'this device has no usable client-decode verdict — run the decode check above first; ' +
            'the loop refuses to run on a machine it has not measured'
        )
        return
      }

      const abort = new AbortController()
      const run = { abort }
      runRef.current = run
      setRunning(true)
      setStatus('starting…')
      setStats(IDLE_STATS)

      // -- run state, closed over by the loops below ----------------------------------------------
      let loopState = INITIAL_LIVE_LOOP_STATE
      let videoPid: number | undefined
      let codecUsed: string | null = null
      let lastAppendedPts: number | null = null
      let anchor: { pts: number; wallMs: number } | null = null
      let lastPresentedPts: number | null = null
      let reanchorOnNextFrame = false
      let stagnantReported = false
      let failure: string | null = null
      const queue: Array<{ frame: VideoFrameLike; pts: number }> = []
      const counters = { decoded: 0, presented: 0, droppedLate: 0, droppedCap: 0, segments: 0, refusedRetried: 0 }
      const presentedAt: number[] = []
      const canvas = canvasRef.current

      const raf = { id: 0 }
      const statsTimer = setInterval(() => {
        const now = performance.now()
        while (presentedAt.length > 0 && now - presentedAt[0] > 5000) presentedAt.shift()
        const windowStart = Math.min(...(presentedAt.length > 0 ? presentedAt : [now]))
        const seconds = Math.max(0.5, (now - windowStart) / 1000)
        setStats({
          codec: codecUsed,
          presentedFps: Math.round(presentedAt.length / seconds),
          decoded: counters.decoded,
          presented: counters.presented,
          droppedLate: counters.droppedLate,
          droppedCap: counters.droppedCap,
          queued: queue.length,
          segments: counters.segments,
          refusedRetried: counters.refusedRetried,
          latencyBehindSec:
            lastAppendedPts !== null && lastPresentedPts !== null
              ? Math.max(0, (lastAppendedPts - lastPresentedPts) / PTS_HZ)
              : null,
          playlistStagnant: stagnantReported
        })
      }, 500)

      const teardown = (message: string | null): void => {
        cancelAnimationFrame(raf.id)
        clearInterval(statsTimer)
        for (const item of queue) item.frame.close()
        queue.length = 0
        try {
          decoderInstance?.close()
        } catch {
          // Already closed by its own error path.
        }
        runRef.current = null
        setRunning(false)
        setStatus(message)
      }

      const decoderInstance = new ctor({
        output: (frame) => {
          counters.decoded += 1
          // The output callback emits presentation order with the chunk's timestamp — µs to 90 kHz.
          const pts = Math.round((frame.timestamp * PTS_HZ) / 1_000_000)
          if (reanchorOnNextFrame) {
            reanchorOnNextFrame = false
            anchor = { pts, wallMs: performance.now() }
          }
          while (queue.length >= QUEUE_CAP) {
            const dropped = queue.shift()
            dropped?.frame.close()
            counters.droppedCap += 1
          }
          queue.push({ frame, pts })
        },
        error: (error) => {
          failure = `decoder error: ${error.message}`
          abort.abort()
        }
      })

      const tick = (): void => {
        raf.id = requestAnimationFrame(tick)
        if (anchor === null) {
          const first = queue[0]
          if (!first) return
          anchor = { pts: first.pts, wallMs: performance.now() }
        }
        const clock = presenterClockPts(anchor.pts, anchor.wallMs, performance.now())
        const choice = choosePresentation(queue, clock)
        if (choice.presentIndex === null) return
        for (let i = 0; i < choice.dropUntil; i++) {
          queue[i].frame.close()
          counters.droppedLate += 1
        }
        queue.splice(0, choice.dropUntil)
        const item = queue.shift()
        if (!item) return
        drawFrame(item.frame, canvas)
        item.frame.close()
        lastPresentedPts = item.pts
        counters.presented += 1
        presentedAt.push(performance.now())
      }
      raf.id = requestAnimationFrame(tick)

      async function fetchWithRemap(item: LiveLoopFetch): Promise<Uint8Array | null> {
        let result = await fetchSegmentBytes(item.url, abort.signal)
        if (result.ok) return result.bytes
        // A refused segment is a signature that expired (the provider signs for ~25s): one fresh
        // playlist, remap by absolute sequence, one retry — the same move the relay makes (v0.44.0).
        if (result.status === 400 || result.status === 403) {
          counters.refusedRetried += 1
          const freshRes = await fetch(source, { signal: abort.signal })
          if (freshRes.ok) {
            const fresh = parseLivePlaylist(await freshRes.text())
            const remapped = fresh ? segmentUrlBySequence(fresh, item.sequence) : null
            if (remapped) result = await fetchSegmentBytes(remapped, abort.signal)
          }
        }
        if (result.ok) return result.bytes
        failure = `segment ${item.sequence} was refused (HTTP ${result.status}) even after a playlist refresh — the provider will not serve it`
        return null
      }

      function decodeSegment(bytes: Uint8Array): boolean {
        const extracted = extractHevcAccessUnits(bytes, videoPid)
        if (!extracted) {
          if (videoPid === undefined) {
            failure = 'no HEVC video track in that segment — check the channel id'
            return false
          }
          return true // an audio-only gap in the video PID: nothing to decode, nothing wrong
        }
        videoPid = extracted.pid
        for (const unit of extracted.units) {
          const appended = appendPts(lastAppendedPts, unit.pts ?? (lastAppendedPts === null ? 0 : lastAppendedPts + Math.round(PTS_HZ / 25)))
          if (appended.discontinuity) reanchorOnNextFrame = true
          lastAppendedPts = appended.pts
          decoderInstance.decode(
            new Chunk({
              type: accessUnitIsKey(unit.data) ? 'key' : 'delta',
              timestamp: Math.round((appended.pts * 1_000_000) / PTS_HZ),
              data: unit.data
            })
          )
        }
        return true
      }

      // -- the poll loop ---------------------------------------------------------------------------
      try {
        let firstSegment = true
        while (!abort.signal.aborted && failure === null) {
          const res = await fetch(source, { signal: abort.signal })
          if (!res.ok) {
            failure = res.status === 401 ? 'the session expired — sign in again' : `the playlist answered HTTP ${res.status}`
            break
          }
          const playlist = parseLivePlaylist(await res.text())
          if (!playlist) {
            failure = 'that URL did not answer an HLS playlist — is the channel up?'
            break
          }
          if (playlist.ended) {
            failure = 'that playlist is not live (ENDLIST) — this loop is for live channels'
            break
          }
          const planned = planLiveLoop(loopState, playlist)
          loopState = planned.state
          if (planned.plan.stagnant && !stagnantReported) {
            stagnantReported = true
            console.warn('[client-decode-loop] the playlist has not advanced — this channel may not be broadcasting')
          }
          for (const item of planned.plan.fetches) {
            if (abort.signal.aborted || failure !== null) break
            const bytes = await fetchWithRemap(item)
            if (bytes === null) break
            if (firstSegment) {
              const units = extractHevcAccessUnits(bytes, videoPid)
              if (!units || units.units.length === 0) {
                failure = 'no HEVC video track in that segment — check the channel id'
                break
              }
              videoPid = units.pid
              const chosen = await pickCodec(ctor, units.units[0].data)
              if (!chosen) {
                failure = 'the platform refused every HEVC configuration this stream offered'
                break
              }
              try {
                decoderInstance.configure(chosen.config)
              } catch (error) {
                failure = `the decoder refused ${chosen.codec} after claiming support for it (${error instanceof Error ? error.message : String(error)}) — a finding about this browser build, not the stream`
                break
              }
              codecUsed = chosen.codec
              setStatus(null)
              firstSegment = false
            }
            if (!decodeSegment(bytes)) break
            counters.segments += 1
          }
          if (failure !== null) break
          await sleep(planned.plan.nextPollMs, abort.signal)
        }
      } catch (error) {
        if (!abort.signal.aborted) failure = error instanceof Error ? error.message : String(error)
      }
      teardown(failure ?? (abort.signal.aborted ? 'stopped' : null))
    })()
  }

  function stop(): void {
    runRef.current?.abort.abort()
  }

  return (
    <section className="admin-section">
      <h2>Client-side live playback — video only</h2>
      <p className="setup-hint">
        Runs the engine a client-side player would use, continuously: poll the playlist, fetch new
        segments while their signatures are young, decode with WebCodecs, and present on the canvas
        paced by the frames&rsquo; own timestamps. Video only for now — audio stays on the server&rsquo;s
        path until this engine joins the player. Runs on the WebCodecs path — Chrome, Brave or Edge;
        Safari plays live HEVC natively and does not need this engine. Two behaviours that are not
        faults: the first seconds drop a burst of frames (joining at the live edge pays for the
        buffer all at once), and a hidden tab draws nothing — the browser stops the draw loop while
        decoding continues. The numbers that matter: presented fps (should sit
        near the stream&rsquo;s own rate), latency behind the edge, and dropped frames (a few under load;
        climbing means the decode cannot keep up).
      </p>
      <div className="epg-section-actions">
        <input
          type="text"
          value={source}
          onChange={(event) => setSource(event.target.value)}
          aria-label="Live channel path to play"
          style={{ minWidth: 320 }}
        />
        {running ? (
          <button type="button" className="admin-small-btn" onClick={stop}>
            Stop
          </button>
        ) : (
          <button type="button" className="admin-small-btn" onClick={start}>
            Play client-side
          </button>
        )}
      </div>
      {status && <p className="setup-hint">{status}</p>}
      {running && (
        <ul className="setup-hint">
          <li>codec: {stats.codec ?? 'negotiating…'} (hardwareAcceleration: prefer-hardware)</li>
          <li>
            presented {stats.presentedFps} fps — decoded {stats.decoded}, drawn {stats.presented}, dropped {stats.droppedLate + stats.droppedCap} (late {stats.droppedLate}, overflow {stats.droppedCap})
          </li>
          <li>
            {stats.queued} frames awaiting presentation · {stats.segments} segments fetched
            {stats.refusedRetried > 0 ? ` · ${stats.refusedRetried} refused segments retried` : ''}
          </li>
          <li>
            {stats.latencyBehindSec !== null ? `${stats.latencyBehindSec.toFixed(1)} s behind the live edge` : 'measuring latency…'}
            {stats.playlistStagnant ? ' — the playlist has not advanced; this channel may not be broadcasting' : ''}
          </li>
          {typeof document !== 'undefined' && document.hidden && (
            <li>drawing paused — this tab is hidden (the browser stops requestAnimationFrame; decoding continues)</li>
          )}
        </ul>
      )}
      <canvas ref={canvasRef} style={{ maxWidth: '100%', marginTop: 8, background: '#000' }} />
    </section>
  )
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      resolve()
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

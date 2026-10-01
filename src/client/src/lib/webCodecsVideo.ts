/**
 * The WebCodecs video engine — the loop the diagnostics surface proved (v0.62.0), generalised for
 * the player: poll the playlist, fetch segments while their signatures are young, demux with PTS,
 * decode on the device's GPU, present on a canvas. Everything risky here is already built and
 * tested — the planner (lib/liveSegmentLoop.ts), the demuxer (lib/tsHevc.ts), the presentation
 * rules (lib/framePresenter.ts); this controller is the wiring that runs them continuously.
 *
 * **The clock.** Video must present against whatever the viewer hears. The player passes
 * `masterWallMs` — the wall-clock instant the audio element is playing, derived from the audio
 * session's own PROGRAM-DATE-TIME stamps — and the controller maps wall instants onto video PTS
 * through the *provider's* PDT stamps (both renditions describe the same source, so the same wall
 * instant names the same content instant). Without a master (the diagnostics surface, or a session
 * that would not start) it falls back to its own wall anchor and says so: silent, but moving.
 */

import {
  accessUnitIsKey,
  codecCandidates,
  extractHevcAccessUnits,
  hevcCodecStringFromAnnexB
} from './tsHevc'
import {
  INITIAL_LIVE_LOOP_STATE,
  parseLivePlaylist,
  planLiveLoop,
  segmentUrlBySequence,
  type LiveLoopFetch
} from './liveSegmentLoop'
import { appendPts, choosePresentation, presenterClockPts, PTS_HZ } from './framePresenter'

// Enough 4K frames to ride out decode jitter, few enough that a stalled presenter cannot pile GPU
// memory into gigabytes — a 4K YUV frame is ~12 MB.
const QUEUE_CAP = 48

export interface WebCodecsVideoStats {
  codec: string | null
  decoded: number
  drawn: number
  droppedLate: number
  droppedOverflow: number
  queued: number
  segments: number
  latencyBehindSec: number | null
  /** True when presenting without the audio clock — silent video, stated rather than hidden. */
  unclocked: boolean
}

interface DecoderInstance {
  configure: (config: Record<string, unknown>) => void
  decode: (chunk: unknown) => void
  close: () => void
}
interface DecoderConstructor {
  new (init: {
    output: (frame: VideoFrameLike) => void
    error: (error: Error) => void
  }): DecoderInstance
  isConfigSupported?: (config: Record<string, unknown>) => Promise<{ supported?: boolean }>
}
export interface VideoFrameLike {
  displayWidth: number
  displayHeight: number
  timestamp: number
  close: () => void
}
type ChunkCtor = new (init: { type: 'key' | 'delta'; timestamp: number; data: Uint8Array }) => unknown
type DrawTarget = {
  clientWidth?: number
  width: number
  height: number
  getContext: (contextId: '2d') => { drawImage: (image: CanvasImageSource, x: number, y: number, w: number, h: number) => void } | null
}

export interface WebCodecsVideoOptions {
  /** The channel's own playlist path — the video comes straight off the provider's segments. */
  source: string
  canvas: DrawTarget | null
  /** The wall-clock instant the audio is playing (epoch ms), or null while it is not ready. */
  masterWallMs?: () => number | null
  now?: () => number
  schedule?: (tick: () => void) => number
  cancelSchedule?: (id: number) => void
  fetchImpl?: typeof fetch
  decoderCtor?: DecoderConstructor
  chunkCtor?: ChunkCtor
  latencySec?: number
  onStats?: (stats: WebCodecsVideoStats) => void
  onNotice?: (message: string | null) => void
  onError?: (message: string) => void
}

export interface WebCodecsVideoHandle {
  stop: () => void
}

/** A decoded frame awaiting its turn; the decoder emits display order, so the queue is pts-sorted. */
interface QueuedFrame {
  frame: VideoFrameLike
  pts: number
}

/** One segment's wall↔PTS anchor, taken from its PROGRAM-DATE-TIME and first decoded frame. */
interface SegmentAnchor {
  pdtMs: number
  firstPts: number
}

export function runWebCodecsVideo(options: WebCodecsVideoOptions): WebCodecsVideoHandle {
  const doFetch = options.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args))
  const now = options.now ?? (() => performance.now())
  const schedule = options.schedule ?? ((tick: () => void) => requestAnimationFrame(tick))
  const cancelSchedule = options.cancelSchedule ?? ((id: number) => cancelAnimationFrame(id))
  const masterWallMs = options.masterWallMs

  const RawCtor = options.decoderCtor ?? (globalThis as unknown as { VideoDecoder?: DecoderConstructor }).VideoDecoder
  const RawChunk = options.chunkCtor ?? (globalThis as unknown as { EncodedVideoChunk?: ChunkCtor }).EncodedVideoChunk
  if (!RawCtor || !RawChunk || typeof RawCtor.isConfigSupported !== 'function') {
    options.onError?.('this browser has no WebCodecs VideoDecoder — the client-side engine cannot run here')
    return { stop: () => {} }
  }
  const ctor: DecoderConstructor = RawCtor
  const Chunk: ChunkCtor = RawChunk

  let stopped = false
  let loopState = INITIAL_LIVE_LOOP_STATE
  let videoPid: number | undefined
  let decoder: DecoderInstance | null = null
  let codecUsed: string | null = null
  let lastAppendedPts: number | null = null
  let lastPresentedPts: number | null = null
  let reanchorOnNextFrame = false
  // The wall anchor for the unclocked fallback: the first drawn frame's pts *is* then.
  let wallAnchor: { pts: number; atMs: number } | null = null
  const queue: QueuedFrame[] = []
  const anchors: SegmentAnchor[] = []
  const counters = { decoded: 0, drawn: 0, droppedLate: 0, droppedOverflow: 0, segments: 0 }
  let unclocked = true
  let unclockedNoticeGiven = false
  let rafId = 0
  let statsAt = 0
  let sleepTimer: ReturnType<typeof setTimeout> | null = null

  /** Wall instant → content PTS, through the nearest segment anchor. Null with no anchors yet. */
  function ptsAtWallMs(wallMs: number): number | null {
    if (anchors.length === 0) return null
    let nearest = anchors[0]
    for (const anchor of anchors) {
      if (Math.abs(anchor.pdtMs - wallMs) < Math.abs(nearest.pdtMs - wallMs)) nearest = anchor
    }
    return nearest.firstPts + (wallMs - nearest.pdtMs) * (PTS_HZ / 1000)
  }

  function drawFrame(frame: VideoFrameLike): void {
    const canvas = options.canvas
    if (!canvas) return
    // At the canvas's displayed size, never the stream's own 3840x2160 (measured 2026-10-01: a
    // full-resolution blit per frame starves presentation on its own).
    const width = Math.max(160, Math.floor(canvas.clientWidth || frame.displayWidth))
    const height = Math.max(90, Math.round((width * frame.displayHeight) / Math.max(1, frame.displayWidth)))
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width
      canvas.height = height
    }
    canvas.getContext('2d')?.drawImage(frame as unknown as CanvasImageSource, 0, 0, width, height)
  }

  function reportStats(): void {
    const at = now()
    if (at - statsAt < 500) return
    statsAt = at
    options.onStats?.({
      codec: codecUsed,
      decoded: counters.decoded,
      drawn: counters.drawn,
      droppedLate: counters.droppedLate,
      droppedOverflow: counters.droppedOverflow,
      queued: queue.length,
      segments: counters.segments,
      latencyBehindSec:
        lastAppendedPts !== null && lastPresentedPts !== null ? Math.max(0, (lastAppendedPts - lastPresentedPts) / PTS_HZ) : null,
      unclocked
    })
  }

  function present(): void {
    if (stopped) return
    rafId = schedule(present)
    if (queue.length === 0) return

    // The master clock first: the audio's wall instant, mapped onto this stream's PTS. Only when
    // no clock (or no anchors to map through) does the engine run on its own wall anchor — and
    // says so once.
    let clockPts: number | null = null
    const wallMs = masterWallMs?.() ?? null
    if (wallMs !== null) {
      clockPts = ptsAtWallMs(wallMs)
      if (clockPts !== null && unclocked) {
        unclocked = false
        options.onNotice?.(null)
      }
    }
    if (clockPts === null) {
      const first = queue[0]
      if (!wallAnchor) wallAnchor = { pts: first.pts, atMs: now() }
      clockPts = presenterClockPts(wallAnchor.pts, wallAnchor.atMs, now())
      if (!unclockedNoticeGiven) {
        unclockedNoticeGiven = true
        options.onNotice?.('presenting without the audio clock — the picture runs on wall time')
      }
    }

    const choice = choosePresentation(queue, clockPts)
    if (choice.presentIndex === null) return
    for (let i = 0; i < choice.dropUntil; i++) {
      queue[i].frame.close()
      counters.droppedLate += 1
    }
    queue.splice(0, choice.dropUntil)
    const item = queue.shift()
    if (!item) return
    drawFrame(item.frame)
    item.frame.close()
    lastPresentedPts = item.pts
    counters.drawn += 1
    reportStats()
  }
  rafId = schedule(present)

  const decoderInstance = new ctor({
    output: (frame) => {
      counters.decoded += 1
      const pts = Math.round((frame.timestamp * PTS_HZ) / 1_000_000)
      if (reanchorOnNextFrame) {
        reanchorOnNextFrame = false
        wallAnchor = { pts, atMs: now() }
      }
      while (queue.length >= QUEUE_CAP) {
        const dropped = queue.shift()
        dropped?.frame.close()
        counters.droppedOverflow += 1
      }
      queue.push({ frame, pts })
    },
    error: (error) => {
      options.onError?.(`decoder error: ${error.message}`)
      stop()
    }
  })
  decoder = decoderInstance

  async function fetchBytes(url: string): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; status: number }> {
    const res = await doFetch(url)
    if (!res.ok) return { ok: false, status: res.status }
    return { ok: true, bytes: new Uint8Array(await res.arrayBuffer()) }
  }

  async function fetchSegment(item: LiveLoopFetch): Promise<Uint8Array | null> {
    let result = await fetchBytes(item.url)
    if (result.ok) return result.bytes
    if (result.status === 400 || result.status === 403) {
      const freshRes = await doFetch(options.source)
      if (freshRes.ok) {
        const fresh = parseLivePlaylist(await freshRes.text())
        const remapped = fresh ? segmentUrlBySequence(fresh, item.sequence) : null
        if (remapped) result = await fetchBytes(remapped)
      }
    }
    if (result.ok) return result.bytes
    return null
  }

  function decodeSegment(bytes: Uint8Array, pdtMs: number | null): boolean {
    const extracted = extractHevcAccessUnits(bytes, videoPid)
    if (!extracted) return videoPid !== undefined // an audio-only gap in the video PID is not a failure
    videoPid = extracted.pid
    const first = extracted.units.find((unit) => unit.pts !== null)
    if (pdtMs !== null && first?.pts != null && anchors.length < 64) {
      anchors.push({ pdtMs, firstPts: first.pts })
    }
    for (const unit of extracted.units) {
      const appended = appendPts(lastAppendedPts, unit.pts ?? (lastAppendedPts === null ? 0 : lastAppendedPts + Math.round(PTS_HZ / 25)))
      if (appended.discontinuity) reanchorOnNextFrame = true
      lastAppendedPts = appended.pts
      decoder?.decode(
        new Chunk({
          type: accessUnitIsKey(unit.data) ? 'key' : 'delta',
          timestamp: Math.round((appended.pts * 1_000_000) / PTS_HZ),
          data: unit.data
        })
      )
    }
    counters.segments += 1
    return true
  }

  async function configureFrom(firstSegment: Uint8Array): Promise<boolean> {
    const units = extractHevcAccessUnits(firstSegment, videoPid)
    if (!units || units.units.length === 0) {
      options.onError?.('no HEVC video track in that channel — the client-side engine cannot run')
      return false
    }
    videoPid = units.pid
    for (const codec of codecCandidates(hevcCodecStringFromAnnexB(units.units[0].data))) {
      const config = { codec, hardwareAcceleration: 'prefer-hardware' as const }
      try {
        const support = await ctor.isConfigSupported?.(config)
        if (support?.supported) {
          decoderInstance.configure(config)
          codecUsed = codec
          return true
        }
      } catch {
        // Try the next candidate — a platform that throws on a string has still answered.
      }
    }
    options.onError?.('the platform refused every HEVC configuration this stream offered')
    return false
  }

  function stop(): void {
    if (stopped) return
    stopped = true
    if (sleepTimer) clearTimeout(sleepTimer)
    cancelSchedule(rafId)
    for (const item of queue) item.frame.close()
    queue.length = 0
    try {
      decoder?.close()
    } catch {
      // Already closed by its own error path.
    }
  }

  void (async () => {
    let firstSegment = true
    let stagnantReported = false
    while (!stopped) {
      try {
        const res = await doFetch(options.source)
        if (!res.ok) {
          options.onError?.(res.status === 401 ? 'the session expired — sign in again' : `the playlist answered HTTP ${res.status}`)
          break
        }
        const playlist = parseLivePlaylist(await res.text())
        if (!playlist) {
          options.onError?.('that channel did not answer an HLS playlist — is it up?')
          break
        }
        if (playlist.ended) {
          options.onError?.('that channel is not live (ENDLIST)')
          break
        }
        const planned = planLiveLoop(loopState, playlist)
        loopState = planned.state
        if (planned.plan.stagnant && !stagnantReported) {
          stagnantReported = true
          options.onNotice?.('the playlist has not advanced — this channel may not be broadcasting')
        }
        for (const item of planned.plan.fetches) {
          if (stopped) break
          const bytes = await fetchSegment(item)
          if (bytes === null) {
            options.onError?.(`segment ${item.sequence} was refused even after a playlist refresh`)
            stop()
            return
          }
          if (firstSegment) {
            firstSegment = false
            if (!(await configureFrom(bytes))) {
              stop()
              return
            }
          }
          const pdtMs = playlist.segments[item.sequence - playlist.mediaSequence]?.programDateTimeMs ?? null
          if (!decodeSegment(bytes, pdtMs)) {
            options.onError?.('no HEVC video track in that channel')
            stop()
            return
          }
        }
        await new Promise<void>((resolve) => {
          sleepTimer = setTimeout(resolve, planned.plan.nextPollMs)
        })
        sleepTimer = null
      } catch (error) {
        if (!stopped) options.onError?.(error instanceof Error ? error.message : String(error))
        break
      }
    }
  })()

  return { stop }
}

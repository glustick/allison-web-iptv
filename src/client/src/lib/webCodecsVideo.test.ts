import { describe, it, expect } from 'vitest'
import { playingWallMsFromFrags, runWebCodecsVideo, type WebCodecsVideoStats } from './webCodecsVideo.js'
import { PTS_HZ } from './framePresenter.js'
import { TS_PACKET_SIZE } from './tsHevc.js'

// The engine controller, driven end to end with fakes: a fetch that serves a dated playlist and
// hand-built MPEG-TS segments carrying real Annex-B HEVC access units, a decoder that answers each
// chunk with a frame, and a presentation loop the test ticks by hand. What this proves is the part
// nothing else covers: playlist → segments → decode → queue → **the audio clock deciding which
// frame is due**, through the PROGRAM-DATE-TIME mapping that keeps two renditions of one source
// in step — plus the wall-clock fallback when no clock is supplied.

function nal(type: number, payload: number[] = []): number[] {
  return [0, 0, 0, 1, type << 1, 1, ...payload]
}

function picture(firstSliceByte: number): Uint8Array {
  return Uint8Array.from([...nal(32), ...nal(33), ...nal(34), ...nal(1, [firstSliceByte, 0xaa])])
}

function psi(payload: Uint8Array): Uint8Array {
  const section = new Uint8Array(1 + payload.length)
  section[0] = 0x00
  section.set(payload, 1)
  return section
}

function packet(pid: number, payload: Uint8Array, start: boolean, counter: number): Uint8Array {
  const out = new Uint8Array(TS_PACKET_SIZE).fill(0xff)
  out[0] = 0x47
  out[1] = (start ? 0x40 : 0x00) | ((pid >> 8) & 0x1f)
  out[2] = pid & 0xff
  out[3] = 0x10 | (counter & 0x0f)
  out.set(payload.subarray(0, TS_PACKET_SIZE - 4), 4)
  return out
}

/** One segment: PAT + PMT + one PES per picture, each PES opening with its own PTS. */
function segment(picturePtss: number[]): Uint8Array {
  const pmtPid = 0x1000
  const videoPid = 0x0101
  const pat = psi(Uint8Array.from([0x00, 0xb0, 0x0d, 0x00, 0x01, 0xc1, 0x00, 0x00, 0x00, 0x01, 0xe0 | (pmtPid >> 8), pmtPid & 0xff, 0, 0, 0, 0]))
  const pmt = psi(
    Uint8Array.from([0x02, 0xb0, 0x12, 0x00, 0x01, 0xc1, 0x00, 0x00, 0xe1, 0x01, 0xf0, 0x00, 0x24, 0xe0 | (videoPid >> 8), videoPid & 0xff, 0xf0, 0x00, 0, 0, 0, 0])
  )
  const packets: Uint8Array[] = [packet(0, pat, true, 0), packet(pmtPid, pmt, true, 0)]
  picturePtss.forEach((pts, index) => {
    const payload = picture(0x80)
    const pesLength = payload.length + 3 + 5
    const header = Uint8Array.from([
      0x00, 0x00, 0x01, 0xe0, (pesLength >> 8) & 0xff, pesLength & 0xff, 0x80, 0x80, 0x05,
      0x20 | ((Math.floor(pts / 2 ** 30) & 0x07) << 1) | 1,
      Math.floor(pts / 2 ** 22) & 0xff,
      ((Math.floor(pts / 2 ** 15) & 0x7f) << 1) | 1,
      Math.floor(pts / 2 ** 7) & 0xff,
      ((pts & 0x7f) << 1) | 1
    ])
    const pes = new Uint8Array(header.length + payload.length)
    pes.set(header, 0)
    pes.set(payload, header.length)
    let written = 0
    while (written < pes.length) {
      const take = Math.min(184, pes.length - written)
      packets.push(packet(videoPid, pes.subarray(written, written + take), written === 0, index + 1))
      written += take
    }
  })
  const out = new Uint8Array(packets.length * TS_PACKET_SIZE)
  packets.forEach((p, i) => out.set(p, i * TS_PACKET_SIZE))
  return out
}

const BASE_PDT = Date.parse('2026-10-01T12:00:00Z')
const SEGMENT_MS = 4000
const SEQUENCES = [100, 101, 102]
const PTS_BASE = 12_000_000
// Two pictures per 4s segment: the frames span their segment's duration, so the PDT mapping and
// the PTS ladder agree — the whole point of the test.
const PTS_PER_SEGMENT = 360_000
const PTS_PER_FRAME = 180_000

function playlistText(): string {
  const lines = ['#EXTM3U', '#EXT-X-TARGETDURATION:4', `#EXT-X-MEDIA-SEQUENCE:${SEQUENCES[0]}`]
  for (const sequence of SEQUENCES) {
    lines.push(`#EXT-X-PROGRAM-DATE-TIME:${new Date(BASE_PDT + (sequence - SEQUENCES[0]) * SEGMENT_MS).toISOString()}`)
    lines.push('#EXTINF:4.0,')
    lines.push(`/seg-${sequence}.ts`)
  }
  return lines.join('\n')
}

interface Frame {
  displayWidth: number
  displayHeight: number
  timestamp: number
  closed: boolean
  close(): void
}

function makeHarness() {
  const drawn: number[] = []
  const stats: WebCodecsVideoStats[] = []
  const notices: Array<string | null> = []
  const errors: string[] = []
  const ticks: Array<() => void> = []
  const closed = { count: 0 }
  let fakeNow = 0

  const canvas = {
    clientWidth: 640,
    width: 0,
    height: 0,
    getContext: () => ({
      drawImage: (image: unknown): void => {
        const frame = image as Frame
        // Frame timestamps are microseconds (WebCodecs' unit); the assertions speak 90 kHz ticks.
        drawn.push(Math.round((frame.timestamp * PTS_HZ) / 1_000_000))
      }
    })
  }

  class FakeDecoder {
    static async isConfigSupported(): Promise<{ supported: boolean }> {
      return { supported: true }
    }
    private pending: Array<{ timestamp: number }> = []
    constructor(private init: { output: (frame: Frame) => void; error: (error: Error) => void }) {}
    configure(): void {}
    decode(chunk: { timestamp: number }): void {
      this.pending.push(chunk)
      setTimeout(() => {
        const next = this.pending.shift()
        if (!next) return
        const frame: Frame = {
          displayWidth: 3840,
          displayHeight: 2160,
          timestamp: next.timestamp,
          closed: false,
          close(): void {
            this.closed = true
            closed.count += 1
          }
        }
        this.init.output(frame)
      }, 0)
    }
    close(): void {}
  }

  const fetchImpl = (async (url: RequestInfo | URL): Promise<Response> => {
    const path = String(url)
    if (path === '/pl.m3u8') return new Response(playlistText(), { status: 200 })
    const match = /^\/seg-(\d+)\.ts$/.exec(path)
    if (match) {
      const index = Number(match[1]) - SEQUENCES[0]
      const firstPts = PTS_BASE + index * PTS_PER_SEGMENT
      return new Response(segment([firstPts, firstPts + PTS_PER_FRAME]).buffer as ArrayBuffer, { status: 200 })
    }
    return new Response('not found', { status: 404 })
  }) as typeof fetch

  return {
    drawn, stats, notices, errors, ticks, canvas, closed, FakeDecoder, fetchImpl,
    now: () => fakeNow,
    advanceNow: (ms: number): void => {
      fakeNow += ms
    }
  }
}

const flush = async (ms = 20): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

describe('runWebCodecsVideo', () => {
  it('presents the frame the audio clock says is due, through the playlist timestamps', async () => {
    const h = makeHarness()
    // The audio clock starts absent, then arrives — exactly the player's shape: the session takes
    // a moment, and the engine must not wait for it to start showing pictures.
    let masterValue: number | null = null
    const handle = runWebCodecsVideo({
      source: '/pl.m3u8',
      canvas: h.canvas as unknown as HTMLCanvasElement,
      fetchImpl: h.fetchImpl,
      decoderCtor: h.FakeDecoder as unknown as never,
      // A plain function, because the controller calls `new Chunk(...)` — arrow functions cannot
      // be constructed.
      chunkCtor: (function FakeChunk(this: unknown, init: { timestamp: number }): unknown {
        return init
      }) as never,
      now: h.now,
      schedule: (tick: () => void) => {
        h.ticks.push(tick)
        return h.ticks.length
      },
      cancelSchedule: () => {},
      masterWallMs: () => masterValue,
      onStats: (stat) => h.stats.push(stat),
      onNotice: (notice) => h.notices.push(notice),
      onError: (message) => h.errors.push(message)
    })

    await flush()
    expect(h.errors).toEqual([])
    // The join is 2 segments back from the edge: sequences 101 and 102 decode — four frames.
    h.ticks.splice(0).forEach((tick) => tick())
    // No clock yet: the wall anchor presents the first frame and the engine says it is unclocked.
    expect(h.drawn).toEqual([PTS_BASE + PTS_PER_SEGMENT])
    expect(h.notices).toContain('presenting without the audio clock — the picture runs on wall time')

    // The clock arrives, one second into segment 101's programme time.
    masterValue = BASE_PDT + SEGMENT_MS + 1000
    h.advanceNow(1000)
    h.ticks.splice(0).forEach((tick) => tick())
    // Nothing new is due yet (the second frame of segment 101 is a second away), and the
    // unclocked notice is cleared the moment the clock takes over.
    expect(h.drawn).toEqual([PTS_BASE + PTS_PER_SEGMENT])
    expect(h.notices[h.notices.length - 1]).toBeNull()

    // Two seconds of programme time pass: the second frame becomes due and is drawn — the PDT
    // mapping put the audio clock and the PTS ladder in the same units.
    masterValue += 2000
    h.advanceNow(2000)
    h.ticks.splice(0).forEach((tick) => tick())
    expect(h.drawn[h.drawn.length - 1]).toBe(PTS_BASE + PTS_PER_SEGMENT + PTS_PER_FRAME)

    handle.stop()
    // Everything decoded is closed — 4K frames are GPU memory, none may leak.
    expect(h.closed.count).toBeGreaterThanOrEqual(4)
  })

  it('refuses to run where the platform has no decoder, and says so', async () => {
    const h = makeHarness()
    const errors: string[] = []
    const handle = runWebCodecsVideo({
      source: '/pl.m3u8',
      canvas: h.canvas as unknown as HTMLCanvasElement,
      fetchImpl: h.fetchImpl,
      decoderCtor: { isConfigSupported: undefined } as unknown as never,
      chunkCtor: (function FakeChunk(this: unknown, init: unknown): unknown {
        return init
      }) as never,
      onError: (message) => errors.push(message)
    })
    expect(errors[0]).toMatch(/no WebCodecs VideoDecoder/)
    handle.stop()
  })
})

describe('playingWallMsFromFrags', () => {
  const frags = [
    { startSec: 0, pdtMs: 1_000_000 },
    { startSec: 4, pdtMs: 1_004_000 },
    { startSec: 8, pdtMs: 1_008_000 }
  ]

  it('maps the playhead through the fragment that contains it', () => {
    expect(playingWallMsFromFrags(frags, 5.5)).toBe(1_005_500)
    expect(playingWallMsFromFrags(frags, 8.25)).toBe(1_008_250)
    expect(playingWallMsFromFrags(frags, 0)).toBe(1_000_000)
  })

  it('extrapolates past the newest buffered fragment, as a live playhead will', () => {
    expect(playingWallMsFromFrags(frags, 10)).toBe(1_010_000)
  })

  it('answers nothing before the first buffered fragment, rather than inventing an instant', () => {
    expect(playingWallMsFromFrags(frags, -1)).toBeNull()
    expect(playingWallMsFromFrags([], 5)).toBeNull()
  })
})

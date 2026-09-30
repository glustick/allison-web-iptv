import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn } from 'child_process'
import { createRequire } from 'module'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  accessUnitIsKey,
  annexBNalTypes,
  codecCandidates,
  extractHevcAccessUnits,
  extractHevcAnnexB,
  extractHevcAnnexBPes,
  findHevcPid,
  hevcCodecStringFromAnnexB,
  splitAccessUnits,
  TS_PACKET_SIZE,
  unwrapPts
} from './tsHevc.js'

describe('splitAccessUnits', () => {
  // The failure this exists for, measured 2026-09-28: the decode check fed a whole elementary stream
  // as ONE chunk, the decoder accepted it, and produced zero frames — which then read as a verdict on
  // the device. A chunk is one frame, so the stream has to be cut into frames first.

  it('splits on the first slice of each picture, keeping parameter sets with what follows', () => {
    const stream = Uint8Array.from([
      ...nal(32), // VPS
      ...nal(33), // SPS
      ...nal(34), // PPS
      ...nal(1, [0x80, 0xaa]), // first slice of picture 1
      ...nal(1, [0x00, 0xbb]), // a later slice of the same picture
      ...nal(1, [0x80, 0xcc]) // first slice of picture 2
    ])
    const units = splitAccessUnits(stream)
    expect(units).toHaveLength(2)
    // The parameter sets belong to the picture they precede.
    expect(units[0][4] >> 1).toBe(32)
    // The second unit begins at its own first slice.
    expect(units[1][4] >> 1).toBe(1)
  })

  it('returns nothing for a stream with no picture in it', () => {
    expect(splitAccessUnits(Uint8Array.from([...nal(32), ...nal(33)])).length).toBe(0)
    expect(splitAccessUnits(new Uint8Array(0)).length).toBe(0)
  })
})


const require = createRequire(import.meta.url)

/** ffmpeg-static, if this platform has a build — the same binary the server's tests use. */
const ffmpegPath: string | null = (() => {
  try {
    const resolved = require('ffmpeg-static') as string | null
    return resolved && existsSync(resolved) ? resolved : null
  } catch {
    return null
  }
})()

function run(command: string, args: string[], input?: Uint8Array): Promise<{ code: number; stderr: string; stdout: Buffer }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args)
    let stderr = ''
    const stdout: Buffer[] = []
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    proc.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
    proc.on('error', reject)
    proc.on('close', (code) => resolve({ code: code ?? -1, stderr, stdout: Buffer.concat(stdout) }))
    if (input) proc.stdin.end(Buffer.from(input))
    else proc.stdin.end()
  })
}

// ---------------------------------------------------------------------------
// Structural rules, on hand-built bytes — cheap, and they pin the parsing.
// ---------------------------------------------------------------------------

function packet(pid: number, payload: Uint8Array, options: { start?: boolean; counter?: number } = {}): Uint8Array {
  const out = new Uint8Array(TS_PACKET_SIZE).fill(0xff)
  out[0] = 0x47
  out[1] = (options.start ? 0x40 : 0x00) | ((pid >> 8) & 0x1f)
  out[2] = pid & 0xff
  out[3] = 0x10 | ((options.counter ?? 0) & 0x0f)
  out.set(payload.subarray(0, TS_PACKET_SIZE - 4), 4)
  return out
}

function psi(payload: Uint8Array): Uint8Array {
  const section = new Uint8Array(1 + payload.length)
  section[0] = 0x00
  section.set(payload, 1)
  return section
}

function transportStream(videoPid: number, payloads: Uint8Array[], streamType = 0x24): Uint8Array {
  const pmtPid = 0x1000
  const pat = psi(
    Uint8Array.from([0x00, 0xb0, 0x0d, 0x00, 0x01, 0xc1, 0x00, 0x00, 0x00, 0x01, 0xe0 | (pmtPid >> 8), pmtPid & 0xff, 0, 0, 0, 0])
  )
  const pmt = psi(
    Uint8Array.from([
      0x02, 0xb0, 0x12, 0x00, 0x01, 0xc1, 0x00, 0x00, 0xe1, 0x01, 0xf0, 0x00,
      streamType, 0xe0 | (videoPid >> 8), videoPid & 0xff, 0xf0, 0x00, 0, 0, 0, 0
    ])
  )
  const packets: Uint8Array[] = [packet(0, pat, { start: true }), packet(pmtPid, pmt, { start: true })]
  // Emitted the way a muxer does it: every packet filled to 184 bytes, so continuation is real and
  // only the *last* packet of a PES is partially filled (the padding case). Splitting a PES down the
  // middle invents mid-PES padding that no muxer produces, which is how an earlier version of this
  // fixture passed while the parser was wrong.
  payloads.forEach((payload, index) => {
    const pesLength = payload.length + 3
    const pes = new Uint8Array(9 + payload.length)
    pes.set([0x00, 0x00, 0x01, 0xe0, (pesLength >> 8) & 0xff, pesLength & 0xff, 0x80, 0x00, 0x00], 0)
    pes.set(payload, 9)
    let written = 0
    let counter = index * 8
    while (written < pes.length) {
      const take = Math.min(184, pes.length - written)
      packets.push(packet(videoPid, pes.subarray(written, written + take), { start: written === 0, counter: counter++ }))
      written += take
    }
  })
  const out = new Uint8Array(packets.length * TS_PACKET_SIZE)
  packets.forEach((p, i) => out.set(p, i * TS_PACKET_SIZE))
  return out
}

const NAL_VPS = Uint8Array.from([0x00, 0x00, 0x00, 0x01, 0x40, 0x01, 0x0c, 0x01])
/** Long enough to span three TS packets, so continuation and end-of-PES padding are both real. */
const NAL_SLICE = Uint8Array.from([
  0x00, 0x00, 0x00, 0x01, 0x26, 0x01, 0xaf, 0x09,
  ...Array.from({ length: 400 }, (_, i) => (i * 7) % 251)
])

describe('findHevcPid', () => {
  it('follows the PAT to the PMT and returns the HEVC elementary PID', () => {
    expect(findHevcPid(transportStream(0x0101, [NAL_VPS]))).toBe(0x0101)
  })

  it('does not match H.264 — this path exists for HEVC, and guessing would be worse than saying nothing', () => {
    expect(findHevcPid(transportStream(0x0101, [NAL_VPS], 0x1b))).toBeNull()
  })

  it('returns null for bytes that are not a transport stream', () => {
    expect(findHevcPid(new Uint8Array(500))).toBeNull()
  })
})

describe('extractHevcAnnexB (hand-built bytes)', () => {
  it('strips the PES header and reassembles a payload split across packets', () => {
    const result = extractHevcAnnexB(transportStream(0x0101, [NAL_VPS]))
    expect(result?.pid).toBe(0x0101)
    expect(Array.from(result!.data)).toEqual([...NAL_VPS])
  })

  it('never emits the 0xff padding a TS packet carries after the PES ends', () => {
    // The bug this test exists for: honouring PES_packet_length is what keeps padding out of the
    // decoder's input, and a hand-built fixture is exactly how it was missed before.
    const result = extractHevcAnnexB(transportStream(0x0101, [NAL_SLICE]))
    expect(Array.from(result!.data)).toEqual([...NAL_SLICE])
    expect(Array.from(result!.data).includes(0xff)).toBe(false)
  })

  it('takes a PID it is given without reading the tables, and returns null for an empty one', () => {
    const ts = transportStream(0x0101, [NAL_VPS])
    expect(extractHevcAnnexB(ts, 0x0101)?.data.length).toBe(NAL_VPS.length)
    expect(extractHevcAnnexB(ts, 0x0202)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// PTS-bearing extraction — the player paces pictures against these numbers, so the reading is pinned
// on hand-built headers first, then on real muxer output below.
// ---------------------------------------------------------------------------

/** A NAL unit in Annex-B form — one start code, the 2-byte HEVC header, then payload. */
function nal(type: number, payload: number[] = []): number[] {
  return [0, 0, 0, 1, type << 1, 1, ...payload]
}

/** A PES header, optionally opening with the five PTS bytes (flags '10', header length 5). */
function pesHeader(payloadLength: number, pts?: number): number[] {
  const withPts = pts !== undefined
  const length = payloadLength + 3 + (withPts ? 5 : 0)
  const base = [0x00, 0x00, 0x01, 0xe0, (length >> 8) & 0xff, length & 0xff, 0x80, withPts ? 0x80 : 0x00, withPts ? 0x05 : 0x00]
  if (!withPts) return base
  const top = Math.floor(pts / 2 ** 30)
  const upper = Math.floor(pts / 2 ** 22) & 0xff
  const middle = Math.floor(pts / 2 ** 15) & 0x7f
  const lower = Math.floor(pts / 2 ** 7) & 0xff
  const bottom = pts & 0x7f
  return [...base, 0x20 | (top << 1) | 1, upper, (middle << 1) | 1, lower, (bottom << 1) | 1]
}

function transportStreamPts(videoPid: number, entries: Array<{ payload: Uint8Array; pts?: number }>): Uint8Array {
  const pmtPid = 0x1000
  const pat = psi(Uint8Array.from([0x00, 0xb0, 0x0d, 0x00, 0x01, 0xc1, 0x00, 0x00, 0x00, 0x01, 0xe0 | (pmtPid >> 8), pmtPid & 0xff, 0, 0, 0, 0]))
  const pmt = psi(
    Uint8Array.from([0x02, 0xb0, 0x12, 0x00, 0x01, 0xc1, 0x00, 0x00, 0xe1, 0x01, 0xf0, 0x00, 0x24, 0xe0 | (videoPid >> 8), videoPid & 0xff, 0xf0, 0x00, 0, 0, 0, 0])
  )
  const packets: Uint8Array[] = [packet(0, pat, { start: true }), packet(pmtPid, pmt, { start: true })]
  entries.forEach((entry, index) => {
    const header = pesHeader(entry.payload.length, entry.pts)
    const pes = new Uint8Array(header.length + entry.payload.length)
    pes.set(header, 0)
    pes.set(entry.payload, header.length)
    let written = 0
    let counter = index * 8
    while (written < pes.length) {
      const take = Math.min(184, pes.length - written)
      packets.push(packet(videoPid, pes.subarray(written, written + take), { start: written === 0, counter: counter++ }))
      written += take
    }
  })
  const out = new Uint8Array(packets.length * TS_PACKET_SIZE)
  packets.forEach((p, i) => out.set(p, i * TS_PACKET_SIZE))
  return out
}

/** One picture's worth of NALs — parameter sets attached to a first slice, as splitAccessUnits expects. */
function picture(firstSliceByte: number, sliceNalType = 1): Uint8Array {
  return Uint8Array.from([...nal(32), ...nal(33), ...nal(34), ...nal(sliceNalType, [firstSliceByte, 0xaa])])
}

describe('extractHevcAnnexBPes / extractHevcAccessUnits', () => {
  it('carries each PES header\'s PTS onto the access units that start inside it', () => {
    const ts = transportStreamPts(0x0101, [
      { payload: picture(0x80), pts: 90_000 },
      { payload: picture(0x80), pts: 99_000 },
      { payload: picture(0x80), pts: 108_000 }
    ])
    const units = extractHevcAccessUnits(ts)
    expect(units?.units.map((unit) => unit.pts)).toEqual([90_000, 99_000, 108_000])
  })

  it('gives every access unit in one PES that PES\'s timestamp', () => {
    // Two pictures in a single PES — legal muxing, and the reason the mapping is by byte range.
    const ts = transportStreamPts(0x0101, [{ payload: Uint8Array.from([...picture(0x80), ...picture(0x80)]), pts: 90_000 }])
    const units = extractHevcAccessUnits(ts)
    expect(units?.units).toHaveLength(2)
    expect(units?.units.every((unit) => unit.pts === 90_000)).toBe(true)
  })

  it('leaves pts null when the PES header carries none, and the bytes still extract identically', () => {
    const ts = transportStreamPts(0x0101, [{ payload: picture(0x80) }])
    const withPes = extractHevcAnnexBPes(ts)
    expect(withPes?.pes[0]?.pts).toBeNull()
    const units = extractHevcAccessUnits(ts)
    expect(units?.units).toHaveLength(1)
    expect(units?.units[0]?.pts).toBeNull()
    expect(Array.from(units!.units[0].data)).toEqual([...picture(0x80)])
  })
})

describe('unwrapPts', () => {
  it('lifts a wrapped PTS onto the continuous timeline', () => {
    const modulus = 2 ** 33
    const beforeWrap = modulus - 90_000
    const afterWrap = 90_000 // really modulus + 90_000
    expect(unwrapPts(beforeWrap, beforeWrap)).toBe(beforeWrap)
    expect(unwrapPts(afterWrap, beforeWrap)).toBe(modulus + 90_000)
    // And backwards across the wrap, should a re-ordering ever hand one over.
    expect(unwrapPts(beforeWrap, modulus + 90_000)).toBe(beforeWrap)
  })
})

describe('accessUnitIsKey', () => {
  it('marks IRAP pictures (IDR, CRA, BLA — NAL types 16-23) as keys', () => {
    expect(accessUnitIsKey(Uint8Array.from([...nal(32), ...nal(33), ...nal(34), ...nal(19, [0x80, 0x00])]))).toBe(true) // IDR_W_RADL
    expect(accessUnitIsKey(Uint8Array.from([...nal(33), ...nal(21, [0x80, 0x00])]))).toBe(true) // CRA
  })

  it('does not mark trailing pictures, and says so for units with no VCL NAL at all', () => {
    expect(accessUnitIsKey(picture(0x80))).toBe(false) // TRAIL_R
    expect(accessUnitIsKey(Uint8Array.from([...nal(32), ...nal(33)]))).toBe(false)
  })
})

describe('hevcCodecStringFromAnnexB', () => {
  /** An SPS NAL whose body starts with the given bytes after the 2-byte NAL header. */
  function sps(body: number[]): Uint8Array {
    return Uint8Array.from([0, 0, 0, 1, 33 << 1, 1, ...body])
  }

  it('reads profile, tier, level and compatibility flags into the string — pinned against the known-good Main shape', () => {
    // Byte layout (verified against x265's own output): [1] space/tier/idc, [2..5] compat flags,
    // [6] first constraint byte, [12] level. Main is idc 1 with compat 0x60000000 → reverse bit
    // order → 6; level 153 is 5.1; constraints 0xB0.
    const annexB = sps([0x01, 0x01, 0x60, 0x00, 0x00, 0x00, 0xb0, 0, 0, 0, 0, 0, 153])
    expect(hevcCodecStringFromAnnexB(annexB)).toBe('hev1.1.6.L153.B0')
  })

  it('reads Main 10 in the high tier with its own compatibility flags', () => {
    // 0x22: space 0, tier H, idc 2 (Main 10); compat 0x20000000 → reverse bit order → 4.
    const annexB = sps([0x01, 0x22, 0x20, 0x00, 0x00, 0x00, 0x90, 0, 0, 0, 0, 0, 153])
    expect(hevcCodecStringFromAnnexB(annexB)).toBe('hev1.2.4.H153.90')
  })

  it('strips emulation prevention before reading the fields', () => {
    // The intended compatibility bytes are 00 00 06 00, which a muxer escapes as 00 00 03 06 00.
    // compat 0x00000600 → reverse bit order → 0x600000.
    const annexB = sps([0x01, 0x01, 0x00, 0x00, 0x03, 0x06, 0x00, 0xb0, 0, 0, 0, 0, 0, 93])
    expect(hevcCodecStringFromAnnexB(annexB)).toBe('hev1.1.600000.L93.B0')
  })

  it('returns null with no SPS to read, and finds the SPS when it is not the stream\'s first NAL', () => {
    expect(hevcCodecStringFromAnnexB(picture(0x80))).toBeNull()
    const afterVps = Uint8Array.from([
      ...nal(32),
      ...sps([0x01, 0x01, 0x60, 0x00, 0x00, 0x00, 0xb0, 0, 0, 0, 0, 0, 153])
    ])
    expect(hevcCodecStringFromAnnexB(afterVps)).toBe('hev1.1.6.L153.B0')
  })

  it('orders the derived string first and never repeats a candidate', () => {
    expect(codecCandidates('hev1.2.4.H153.90')).toEqual(['hev1.2.4.H153.90', 'hev1.2.4.L153.B0', 'hev1.1.6.L153.B0'])
    expect(codecCandidates('hev1.1.6.L153.B0')).toEqual(['hev1.1.6.L153.B0', 'hev1.2.4.L153.B0'])
    expect(codecCandidates(null)).toEqual(['hev1.2.4.L153.B0', 'hev1.1.6.L153.B0'])
  })
})

// ---------------------------------------------------------------------------
// Real bytes. A hand-built fixture passes while the parser is wrong (it did), so the extraction is
// also proved against a transport stream that genuinely carries HEVC, and the extracted stream is
// handed to ffmpeg — if the extraction dropped a byte in the wrong place, nothing decodes.
// ---------------------------------------------------------------------------

describe.skipIf(!ffmpegPath)('extractHevcAnnexB (real HEVC-in-TS bytes)', () => {
  let dir = ''
  let segment: Uint8Array

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'allisoniptv-tshevc-'))
    const fixture = join(dir, 'hevc.ts')
    const built = await run(ffmpegPath as string, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc=duration=2:size=320x240:rate=10',
      '-c:v', 'libx265', '-preset', 'ultrafast', '-x265-params', 'log-level=error',
      '-f', 'mpegts', fixture
    ])
    expect(built.code).toBe(0)
    segment = new Uint8Array(readFileSync(fixture))
  }, 60000)

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('finds the HEVC PID in a real transport stream', () => {
    expect(findHevcPid(segment)).not.toBeNull()
  })

  it('extracts parameter sets and slices, and nothing that is not HEVC', () => {
    const result = extractHevcAnnexB(segment)
    expect(result).not.toBeNull()

    const types = annexBNalTypes(result!.data)
    // 32 VPS, 33 SPS, 34 PPS — in-band, which is why WebCodecs needs no codec description.
    expect(types).toContain(32)
    expect(types).toContain(33)
    expect(types).toContain(34)
    // 0-31 are coded slices; 2s at 10fps is twenty of them, so this is a real elementary stream.
    expect(types.filter((t) => t <= 31).length).toBeGreaterThan(10)
  })

  it('produces a stream ffmpeg decodes — the check a hand-built fixture cannot make', () => {
    const result = extractHevcAnnexB(segment)!
    const frameCount = join(dir, 'extracted.hevc')
    writeFileSync(frameCount, Buffer.from(result.data))
    return run(ffmpegPath as string, [
      '-hide_banner', '-f', 'hevc', '-i', frameCount, '-f', 'null', '-'
    ]).then((decoded) => {
      expect(decoded.code).toBe(0)
      const frames = [...decoded.stderr.matchAll(/frame=\s*(\d+)/g)].pop()
      expect(frames, `ffmpeg reported no frames:\n${decoded.stderr.slice(-800)}`).not.toBeNull()
      expect(Number(frames![1]), `ffmpeg decoded ${frames?.[1]} frames:\n${decoded.stderr.slice(-800)}`).toBeGreaterThan(10)
    })
  }, 60000)

  it('carries every picture\'s PTS from the real muxer, on the fixture\'s own display cadence', () => {
    const units = extractHevcAccessUnits(segment)!.units
    expect(units.length).toBeGreaterThan(10)
    // The fixture has B-frames, so decode order (the order units arrive in) is NOT presentation
    // order — PTS may legitimately move backwards between consecutive units. What must hold is the
    // display cadence: sorted, the timestamps are exactly one frame apart (10 fps = 9000 ticks).
    const ptsList = units.map((unit) => unit.pts)
    expect(ptsList.every((pts): pts is number => pts !== null)).toBe(true)
    const sorted = [...ptsList].sort((a, b) => (a as number) - (b as number)) as number[]
    expect(sorted[0]).toBeGreaterThan(0)
    for (let i = 1; i < sorted.length; i++) {
      expect(Math.abs(sorted[i] - sorted[i - 1] - 9_000)).toBeLessThanOrEqual(90)
    }
  })

  it('derives the codec string from the real SPS — the profile the stream actually is', async () => {
    const units = extractHevcAccessUnits(segment)!.units
    // The default fixture encodes testsrc, which is RGB, so libx265 writes Range Extensions
    // (profile_idc 4) — ffmpeg's own banner for this fixture says "hevc (Rext)".
    expect(hevcCodecStringFromAnnexB(units[0].data)).toMatch(/^hev1\.4\./)
    expect(accessUnitIsKey(units[0].data)).toBe(true)

    // And the forced-Main twin must derive Main — the same derivation, cross-checked against a
    // stream whose profile is known because it was requested.
    const mainFixture = join(dir, 'main.ts')
    const built = await run(ffmpegPath as string, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc=duration=1:size=320x240:rate=10',
      '-pix_fmt', 'yuv420p', '-c:v', 'libx265', '-preset', 'ultrafast', '-profile', 'main',
      '-x265-params', 'log-level=error', '-f', 'mpegts', mainFixture
    ])
    expect(built.code).toBe(0)
    const mainUnits = extractHevcAccessUnits(new Uint8Array(readFileSync(mainFixture)))!.units
    expect(hevcCodecStringFromAnnexB(mainUnits[0].data)).toMatch(/^hev1\.1\./)
    expect(accessUnitIsKey(mainUnits[0].data)).toBe(true)
  }, 60000)

  it('extracts the same bytes as ffmpeg does for a real captured 4K segment, when one is supplied', async () => {
    // UHD_TS_SEGMENT points at a real segment (a 4K feed is ~7 MB — too big to commit). Run
    // `UHD_TS_SEGMENT=/path/to/seg.ts npx vitest run tsHevc` to exercise it.
    const realPath = process.env.UHD_TS_SEGMENT
    if (!realPath || !existsSync(realPath)) return
    const real = new Uint8Array(readFileSync(realPath))
    const result = extractHevcAnnexB(real)
    expect(result).not.toBeNull()
    const types = annexBNalTypes(result!.data)
    expect(types).toContain(32)
    expect(types.filter((t) => t <= 31).length).toBeGreaterThan(10)

    const out = join(dir, 'real.hevc')
    writeFileSync(out, Buffer.from(result!.data))
    const decoded = await run(ffmpegPath as string, ['-hide_banner', '-f', 'hevc', '-i', out, '-f', 'null', '-'])
    expect(decoded.code).toBe(0)
    const frames = [...decoded.stderr.matchAll(/frame=\s*(\d+)/g)].pop()
    expect(frames).not.toBeNull()
    // A 4s segment at 50 fps is two hundred frames; anything close to that means the extraction kept
    // the whole picture rather than a fragment of it.
    expect(Number(frames![1])).toBeGreaterThan(50)
  }, 120000)
})

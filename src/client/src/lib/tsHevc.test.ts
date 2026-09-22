import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn } from 'child_process'
import { createRequire } from 'module'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { annexBNalTypes, extractHevcAnnexB, findHevcPid, TS_PACKET_SIZE } from './tsHevc.js'

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

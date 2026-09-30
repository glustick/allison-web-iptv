/**
 * Pull the HEVC elementary stream out of an MPEG-TS segment, client-side.
 *
 * This is the first step of moving video work off the NAS (ROADMAP "0. Client-side decoding"):
 *
 * - The provider delivers **HEVC in MPEG-TS** — exactly the combination nothing on the playback side
 *   can use. The macOS native HLS pipeline presents no video for it at all (measured 2026-09-22: 0
 *   decoded frames, `presentationSize 0x0`, audio only) and MSE in Chromium will not append it, so the
 *   server has been re-wrapping it — and, when the browser cannot decode HEVC at all, re-encoding it,
 *   which is where a 4K feed pins the NAS at ~400% CPU and falls behind the live edge.
 * - **TS demuxing is easy and the video bitstream already sits in it unmodified.** Pull the video PID's
 *   PES payloads out and you have HEVC in Annex-B form with in-band parameter sets — precisely what
 *   WebCodecs' `VideoDecoder` accepts *without* a codec description. No ffmpeg, no remux, no re-encode,
 *   and the bits are the provider's.
 *
 * Deliberately pure and dependency-free — bytes in, elementary stream out, no DOM, no browser API — so
 * the whole thing is verifiable in Node against real captured bytes before any of it is wired to a
 * decoder.
 */

/** The only packet size MPEG-TS has; anything that disagrees is not a TS stream. */
export const TS_PACKET_SIZE = 188

const PAT_PID = 0
const STREAM_TYPE_HEVC = 0x24

export interface HevcStream {
  /** The PID the video was taken from. */
  pid: number
  /** HEVC in Annex-B: NAL units separated by start codes, no length prefixes. */
  data: Uint8Array
}

/** Reads one PSI section starting at `start`, stopping before its CRC. */
function findSection(ts: Uint8Array, start: number, end: number): Uint8Array | null {
  if (start + 3 >= end) return null
  const sectionStart = start + 1 + ts[start]
  if (sectionStart + 3 >= end) return null
  const sectionLength = ((ts[sectionStart + 1] & 0x0f) << 8) | ts[sectionStart + 2]
  const sectionEnd = Math.min(sectionStart + 3 + sectionLength - 4, end)
  if (sectionEnd <= sectionStart) return null
  return ts.subarray(sectionStart, sectionEnd)
}

/**
 * Finds the PID carrying HEVC by reading the PAT and then the PMT it points at.
 *
 * Null when the segment does not say — the caller may already know the PID from a previous segment of
 * the same channel. H.264 is deliberately not matched: this path exists for HEVC, and guessing would
 * hand the decoder the wrong bitstream.
 */
export function findHevcPid(ts: Uint8Array): number | null {
  let pmtPid: number | null = null

  for (let offset = 0; offset + TS_PACKET_SIZE <= ts.length; offset += TS_PACKET_SIZE) {
    if (ts[offset] !== 0x47) continue
    if ((ts[offset + 1] & 0x40) === 0) continue // only a table's first packet carries the section
    const pid = ((ts[offset + 1] & 0x1f) << 8) | ts[offset + 2]
    const payloadOffset = offset + 4 + (ts[offset + 3] & 0x20 ? 1 + ts[offset + 4] : 0)
    if (payloadOffset >= offset + TS_PACKET_SIZE) continue

    if (pmtPid === null && pid === PAT_PID) {
      const table = findSection(ts, payloadOffset, offset + TS_PACKET_SIZE)
      if (!table) continue
      for (let i = 8; i + 4 <= table.length; i += 4) {
        const programNumber = (table[i] << 8) | table[i + 1]
        if (programNumber === 0) continue // network PID, not a program
        pmtPid = ((table[i + 2] & 0x1f) << 8) | table[i + 3]
        break
      }
      continue
    }

    if (pmtPid !== null && pid === pmtPid) {
      const table = findSection(ts, payloadOffset, offset + TS_PACKET_SIZE)
      if (!table) continue
      const infoLength = ((table[10] & 0x0f) << 8) | table[11]
      let i = 12 + infoLength
      while (i + 5 <= table.length) {
        const streamType = table[i]
        const elementaryPid = ((table[i + 1] & 0x1f) << 8) | table[i + 2]
        if (streamType === STREAM_TYPE_HEVC) return elementaryPid
        const esInfoLength = ((table[i + 3] & 0x0f) << 8) | table[i + 4]
        i += 5 + esInfoLength
      }
    }
  }

  return null
}

/**
 * The NAL unit types present in an Annex-B stream, in order — `32` VPS, `33` SPS, `34` PPS, and the
 * coded slices in between. Used by the tests to prove the extraction produced real HEVC rather than
 * plausible-looking bytes.
 */
export function annexBNalTypes(annexB: Uint8Array): number[] {
  const types: number[] = []
  let i = 0
  while (i + 5 < annexB.length) {
    if (annexB[i] !== 0 || annexB[i + 1] !== 0) {
      i += 1
      continue
    }
    let prefix = 0
    if (annexB[i + 2] === 1) prefix = 3
    else if (annexB[i + 2] === 0 && annexB[i + 3] === 1) prefix = 4
    if (prefix === 0) {
      i += 1
      continue
    }
    const header = annexB[i + prefix]
    types.push((header >> 1) & 0x3f)
    i += prefix + 2
  }
  return types
}

/**
 * Extracts the video PID's elementary stream as Annex-B.
 *
 * Two details that are easy to get wrong, and were:
 *
 * 1. **A PES packet's own header must be stripped** on the packet where it starts (the 9-byte header
 *    plus its optional extension), so only elementary payload survives.
 * 2. **`PES_packet_length` must be honoured.** MPEG-TS pads the last packet of a PES to 188 bytes, so
 *    without the length the padding (`0xff`) reaches the decoder as if it were NAL data. A length of 0
 *    means "unset", which is legal for video: the stream is then unbounded, and the decoder resyncs on
 *    start codes.
 */
export function extractHevcAnnexB(ts: Uint8Array, videoPid?: number): HevcStream | null {
  const withPes = extractHevcAnnexBPes(ts, videoPid)
  return withPes && { pid: withPes.pid, data: withPes.data }
}

/** One PES packet's payload, located in the concatenated Annex-B stream, with its PTS when it has one. */
export interface HevcPes {
  /** Presentation timestamp in 90 kHz ticks, straight from the PES header. Null when absent. */
  pts: number | null
  /** Half-open byte range of this PES's elementary payload within `data`. */
  start: number
  end: number
}

export interface HevcStreamWithPes extends HevcStream {
  /** Every PES packet reassembled into `data`, in order, so timestamps can be mapped onto bytes. */
  pes: HevcPes[]
}

/**
 * The PTS-keeping half of the extraction. The player paces pictures against a clock, and the only
 * honest place a picture's time can come from is its own PES header — everything else (wall clock at
 * fetch time, playlist position) is a guess the provider is free to disagree with.
 */
export function extractHevcAnnexBPes(ts: Uint8Array, videoPid?: number): HevcStreamWithPes | null {
  const pid = videoPid ?? findHevcPid(ts)
  if (pid === null) return null

  const chunks: Uint8Array[] = []
  const pesEntries: HevcPes[] = []
  let currentPes: HevcPes | null = null
  let total = 0
  let remaining = Number.POSITIVE_INFINITY

  for (let offset = 0; offset + TS_PACKET_SIZE <= ts.length; offset += TS_PACKET_SIZE) {
    if (ts[offset] !== 0x47) continue
    if ((((ts[offset + 1] & 0x1f) << 8) | ts[offset + 2]) !== pid) continue

    const payloadStarts = (ts[offset + 1] & 0x40) !== 0
    const adaptationControl = (ts[offset + 3] >> 4) & 0x03
    if (adaptationControl === 0 || adaptationControl === 2) continue // no payload in this packet

    let payloadOffset = offset + 4
    if (adaptationControl === 3) {
      if (payloadOffset >= offset + TS_PACKET_SIZE) continue
      payloadOffset += 1 + ts[payloadOffset]
    }
    if (payloadOffset >= offset + TS_PACKET_SIZE) continue

    let payload = ts.subarray(payloadOffset, offset + TS_PACKET_SIZE)

    if (payloadStarts) {
      // PES: 00 00 01 <stream id> <length:2> <flags:2> <header length> <optional header...>
      if (payload.length < 9 || payload[0] !== 0x00 || payload[1] !== 0x00 || payload[2] !== 0x01) continue
      const pesLength = (payload[4] << 8) | payload[5]
      const headerLength = payload[8]
      // The top two bits of the second flags byte say whether the optional header starts with a PTS
      // ('10' PTS only, '11' PTS and DTS) — and the PTS's own 5 bytes sit right there in the header,
      // so it is read before the header is stripped.
      const pts =
        (payload[7] & 0xc0) >= 0x80 && payload.length >= 14 ? readPesPts(payload, 9) : null
      currentPes = { pts, start: total, end: total }
      pesEntries.push(currentPes)
      payload = payload.subarray(Math.min(9 + headerLength, payload.length))
      remaining = pesLength === 0 ? Number.POSITIVE_INFINITY : Math.max(pesLength - 3 - headerLength, 0)
    }

    if (remaining <= 0) continue // the padding that follows a completed PES packet
    if (Number.isFinite(remaining) && payload.length > remaining) payload = payload.subarray(0, remaining)
    if (Number.isFinite(remaining)) remaining -= payload.length
    if (payload.length === 0) continue

    chunks.push(payload)
    total += payload.length
    if (currentPes) currentPes.end = total
  }

  if (total === 0) return null

  const data = new Uint8Array(total)
  let written = 0
  for (const chunk of chunks) {
    data.set(chunk, written)
    written += chunk.length
  }
  return { pid, data, pes: pesEntries.filter((entry) => entry.end > entry.start) }
}

/** The 33-bit PTS spread across five bytes, each with a marker bit — kept in float math, since 2^33 overflows int32. */
function readPesPts(pes: Uint8Array, at: number): number {
  const top = (pes[at] & 0x0e) >> 1 // PTS[32:30]
  const upper = pes[at + 1] // PTS[29:22]
  const middle = pes[at + 2] >> 1 // PTS[21:15]
  const lower = pes[at + 3] // PTS[14:7]
  const bottom = pes[at + 4] >> 1 // PTS[6:0]
  return top * 2 ** 30 + upper * 2 ** 22 + middle * 2 ** 15 + lower * 2 ** 7 + bottom
}

/** An encoded frame, with the presentation time its PES header carried. */
export interface HevcAccessUnit {
  data: Uint8Array
  pts: number | null
}

export interface HevcAccessUnits {
  pid: number
  units: HevcAccessUnit[]
}

/**
 * Extracts access units with their PTS — the shape the client-side player consumes. A unit takes the
 * timestamp of the PES its first byte sits in; a PES usually carries exactly one picture, and when it
 * carries several they share a presentation time anyway (that is what a PES boundary means).
 */
export function extractHevcAccessUnits(ts: Uint8Array, videoPid?: number): HevcAccessUnits | null {
  const stream = extractHevcAnnexBPes(ts, videoPid)
  if (!stream) return null
  const ranges = splitAccessUnitRanges(stream.data)
  const units: HevcAccessUnit[] = []
  let pesIndex = 0
  for (const range of ranges) {
    while (pesIndex + 1 < stream.pes.length && stream.pes[pesIndex + 1].start <= range.start) pesIndex += 1
    const pes = stream.pes[pesIndex]
    units.push({
      data: stream.data.subarray(range.start, range.end),
      pts: pes && pes.start <= range.start ? pes.pts : null
    })
  }
  return { pid: stream.pid, units }
}

/**
 * True when the access unit starts a clean random-access point — an IRAP picture (IDR, CRA, BLA),
 * NAL types 16-23. The decode loop marks its chunks `key` from this rather than assuming the first
 * frame of a segment is one; feeding a delta chunk where a key is required makes the decoder refuse
 * the whole segment, and the provider is under no obligation to align keyframes with segments.
 */
export function accessUnitIsKey(unit: Uint8Array): boolean {
  let i = 0
  while (i + 5 < unit.length) {
    if (unit[i] !== 0 || unit[i + 1] !== 0) {
      i += 1
      continue
    }
    let prefix = 0
    if (unit[i + 2] === 1) prefix = 3
    else if (unit[i + 2] === 0 && unit[i + 3] === 1) prefix = 4
    if (prefix === 0) {
      i += 1
      continue
    }
    const nalType = (unit[i + prefix] >> 1) & 0x3f
    if (nalType <= 31) return nalType >= 16 && nalType <= 23
    i += prefix + 2
  }
  return false
}

/** PTS is a 33-bit field, so it wraps roughly every 26.5 hours. */
export const PTS_MODULUS = 2 ** 33

/**
 * Lifts a wrapped PTS onto the same continuous timeline as `previousUnwrapped`, choosing the
 * representation within ±2^32 of it. Frames arrive in order, so the nearest interpretation is always
 * the right one.
 */
export function unwrapPts(pts: number, previousUnwrapped: number): number {
  const previousMod = ((previousUnwrapped % PTS_MODULUS) + PTS_MODULUS) % PTS_MODULUS
  let delta = pts - previousMod
  delta = ((delta % PTS_MODULUS) + PTS_MODULUS) % PTS_MODULUS
  if (delta > PTS_MODULUS / 2) delta -= PTS_MODULUS
  return previousUnwrapped + delta
}

/**
 * Reads the codec string out of the stream's own SPS — `hev1.<profile>.<compat>.<tier><level>.<constraints>`.
 *
 * The decode check used to hardcode `hev1.1.6.L153.B0` (Main, level 5.1), which is wrong the moment
 * the channel is one of this provider's Main 10 UHD feeds: the codec string is how the platform picks
 * a decoder, and Main against Main 10 bits is a guess, not a fact. The SPS says what the stream
 * actually is — profile, tier, level, compatibility flags, the lot — and it is in-band, so it costs
 * nothing to read. Compatibility flags are written in reverse bit order per ISO/IEC 14496-15, which
 * is why a Main profile's 0x60000000 reads as `6` in every string you have seen.
 *
 * Null when the stream carries no SPS before its first slice — nothing honest to say then.
 */
export function hevcCodecStringFromAnnexB(annexB: Uint8Array): string | null {
  let i = 0
  while (i + 5 < annexB.length) {
    if (annexB[i] !== 0 || annexB[i + 1] !== 0) {
      i += 1
      continue
    }
    let prefix = 0
    if (annexB[i + 2] === 1) prefix = 3
    else if (annexB[i + 2] === 0 && annexB[i + 3] === 1) prefix = 4
    if (prefix === 0) {
      i += 1
      continue
    }
    const nalType = (annexB[i + prefix] >> 1) & 0x3f
    if (nalType === 33) return codecStringFromSps(annexB, i + prefix + 2)
    if (nalType <= 31) return null // slices before any parameter set: no SPS to read
    i += prefix + 2
  }
  return null
}

/**
 * The SPS's profile_tier_level sits in its first bytes — unescape emulation prevention, then read the fields.
 *
 * The byte layout, pinned empirically against x265's own output for Main, Main 10 and Rext (the
 * positions cost a debugging cycle to get right, so they are written down):
 *
 *   [0] vps id / sub-layers / nesting    [1] profile_space(2) tier(1) profile_idc(5)
 *   [2..5] 32 compatibility flags        [6..11] constraint indicator flags
 *   [12] level_idc
 */
function codecStringFromSps(annexB: Uint8Array, rbspStart: number): string | null {
  const rbsp: number[] = []
  let zeros = 0
  for (let j = rbspStart; j < annexB.length && rbsp.length < 13; j++) {
    const byte = annexB[j]
    if (zeros >= 2 && byte === 3) {
      zeros = 0
      continue
    }
    rbsp.push(byte)
    zeros = byte === 0 ? zeros + 1 : 0
  }
  if (rbsp.length < 13) return null
  const profileSpace = (rbsp[1] >> 6) & 0x03
  const tierFlag = (rbsp[1] >> 5) & 0x01
  const profileIdc = rbsp[1] & 0x1f
  const compatFlags = rbsp[2] * 2 ** 24 + rbsp[3] * 2 ** 16 + rbsp[4] * 2 ** 8 + rbsp[5]
  const constraints = rbsp[6]
  const levelIdc = rbsp[12]
  if (profileIdc === 0) return null
  const space = profileSpace === 0 ? '' : String.fromCharCode(0x40 + profileSpace)
  const compatHex = reverseBits32(compatFlags).toString(16)
  return `hev1.${space}${profileIdc}.${compatHex}.${tierFlag ? 'H' : 'L'}${levelIdc}.${constraints
    .toString(16)
    .toUpperCase()
    .padStart(2, '0')}`
}

function reverseBits32(value: number): number {
  let reversed = 0
  for (let bit = 0; bit < 32; bit++) reversed = reversed * 2 + ((value >> bit) & 1)
  return reversed
}

/** The strings to try, derived string first — the stream's own answer, then this provider's two known shapes. */
export function codecCandidates(derived: string | null): string[] {
  const fallbacks = ['hev1.2.4.L153.B0', 'hev1.1.6.L153.B0']
  return [...new Set(derived ? [derived, ...fallbacks] : fallbacks)]
}

/**
 * Splits an Annex-B elementary stream into **access units** — one per encoded frame.
 *
 * This exists because of a measured failure worth recording. The decode check used to hand the whole
 * elementary stream to `decode()` as a *single* `EncodedVideoChunk`. A chunk is one frame by
 * definition, and Chrome's HEVC decoder accepted the configuration and then produced **zero frames**:
 * `decoded frames: 0`, `0.0 frames/second`, and a 300x150 canvas — the canvas default, so nothing had
 * ever been drawn — and that was saved as if it were a verdict on the device. The check was broken,
 * not the machine, which is exactly the kind of false negative this project keeps having to unlearn.
 *
 * A new access unit begins at the first slice of a picture (`first_slice_segment_in_pic_flag`, the top
 * bit of the first byte of a VCL NAL's payload); parameter sets and SEI that precede it belong to it,
 * so they are attached to the unit that follows. No full parse is needed — just the NAL walk this
 * module already does.
 */
export function splitAccessUnits(annexB: Uint8Array): Uint8Array[] {
  return splitAccessUnitRanges(annexB).map((range) => annexB.subarray(range.start, range.end))
}

/** A located access unit — byte offsets into the Annex-B stream, so timestamps can be mapped onto them. */
export interface AccessUnitRange {
  start: number
  end: number
}

export function splitAccessUnitRanges(annexB: Uint8Array): AccessUnitRange[] {
  const units: AccessUnitRange[] = []
  let unitStart = -1
  let unitHasSlice = false
  let i = 0
  while (i + 5 < annexB.length) {
    if (annexB[i] !== 0 || annexB[i + 1] !== 0) {
      i += 1
      continue
    }
    let prefix = 0
    if (annexB[i + 2] === 1) prefix = 3
    else if (annexB[i + 2] === 0 && annexB[i + 3] === 1) prefix = 4
    if (prefix === 0) {
      i += 1
      continue
    }
    const nalType = (annexB[i + prefix] >> 1) & 0x3f
    const isVcl = nalType <= 31
    // first_slice_segment_in_pic_flag — meaningful only on a VCL NAL, and only when its first
    // payload byte is actually present.
    const firstSlice = isVcl && i + prefix + 2 < annexB.length && (annexB[i + prefix + 2] & 0x80) !== 0

    if (unitStart < 0) {
      unitStart = i
    } else if (isVcl && firstSlice && unitHasSlice) {
      units.push({ start: unitStart, end: i })
      unitStart = i
      unitHasSlice = false
    }
    if (isVcl) unitHasSlice = true
    i += prefix + 2
  }
  if (unitStart >= 0 && unitHasSlice) units.push({ start: unitStart, end: annexB.length })
  return units
}

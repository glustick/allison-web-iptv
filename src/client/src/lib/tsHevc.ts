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
  const pid = videoPid ?? findHevcPid(ts)
  if (pid === null) return null

  const chunks: Uint8Array[] = []
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
      payload = payload.subarray(Math.min(9 + headerLength, payload.length))
      remaining = pesLength === 0 ? Number.POSITIVE_INFINITY : Math.max(pesLength - 3 - headerLength, 0)
    }

    if (remaining <= 0) continue // the padding that follows a completed PES packet
    if (Number.isFinite(remaining) && payload.length > remaining) payload = payload.subarray(0, remaining)
    if (Number.isFinite(remaining)) remaining -= payload.length
    if (payload.length === 0) continue

    chunks.push(payload)
    total += payload.length
  }

  if (total === 0) return null

  const data = new Uint8Array(total)
  let written = 0
  for (const chunk of chunks) {
    data.set(chunk, written)
    written += chunk.length
  }
  return { pid, data }
}

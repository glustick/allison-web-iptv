/**
 * Which audio tracks does this stream actually have, and in what order?
 *
 * The app's silent-audio fallback cannot help in Safari: it is driven by `webkitAudioDecodedByteCount`,
 * which exists only in Chromium. So on Safari an E-AC-3-first channel (Sky Atlantic, Sky One) plays
 * perfectly and **silently**, and nothing ever switches to the transcode — while the same channels work
 * in Chrome, which is why this looked like a channel-specific mystery.
 *
 * The server can already answer the question directly: it probes the stream and reports each audio
 * track's codec. Asking it *before* playing means the decision is made from evidence rather than from a
 * counter only one browser family has.
 *
 * Measured: the transcoder re-encodes to AAC LC whatever it is given, so once the fallback fires the
 * audio is audible regardless of which track the provider put first.
 */
export interface ProbedAudioTrack {
  index: number
  codec: string
}

export interface ProbedStream {
  audioTracks: ProbedAudioTrack[]
  /** The video codec the source actually carries, as ffmpeg names it ("hevc", "h264", …), or null. */
  videoCodec: string | null
}

/** Per session: a channel's tracks do not change from one play to the next. */
const probed = new Map<string, ProbedStream>()

export function forgetProbedTracks(): void {
  probed.clear()
}

import { rememberStreamFacts, rememberedTracks } from './transcodeHints'

export async function probeStreamTracks(
  url: string,
  fetchImpl: typeof fetch = fetch
): Promise<ProbedStream> {
  const cached = probed.get(url)
  if (cached) return cached
  // Remembered from a previous session — the server keeps what each channel's stream carries
  // (lib/channelPlans.ts, mirrored by lib/transcodeHints.ts), so a fresh page load does not have to
  // probe a live source again. That ffprobe is the "waiting for timeouts" the operator asked to stop
  // paying on every click (2026-09-28).
  const remembered = rememberedTracks(url)
  if (remembered) {
    const payload: ProbedStream = {
      audioTracks: remembered.audioCodecs.map((codec, index) => ({ index, codec })),
      videoCodec: remembered.videoCodec
    }
    probed.set(url, payload)
    return payload
  }
  try {
    const res = await fetchImpl('/api/transcode/probeTracks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceUrl: url })
    })
    if (!res.ok) return { audioTracks: [], videoCodec: null }
    const data = (await res.json()) as {
      audioTracks?: { index?: number; codec?: string }[]
      videoCodec?: string
    }
    const payload: ProbedStream = {
      audioTracks: (data.audioTracks ?? [])
        .map((track, position) => ({ index: track.index ?? position, codec: track.codec ?? '' }))
        .sort((a, b) => a.index - b.index),
      videoCodec: typeof data.videoCodec === 'string' && data.videoCodec ? data.videoCodec : null
    }
    probed.set(url, payload)
    // Recorded so the next session — or another device in the house — does not ask the provider again.
    rememberStreamFacts(url, {
      videoCodec: payload.videoCodec,
      audioCodecs: payload.audioTracks.map((track) => track.codec)
    })
    return payload
  } catch {
    // A failed probe is not evidence of anything: play the stream as we would have anyway.
    return { audioTracks: [], videoCodec: null }
  }
}

/** The audio-only view of the same probe and the same cache, for callers that only need tracks. */
export async function probeAudioTracks(
  url: string,
  fetchImpl: typeof fetch = fetch
): Promise<ProbedAudioTrack[]> {
  return (await probeStreamTracks(url, fetchImpl)).audioTracks
}

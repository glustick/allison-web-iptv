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

/** Per session: a channel's audio tracks do not change from one play to the next. */
const probed = new Map<string, ProbedAudioTrack[]>()

export function forgetProbedTracks(): void {
  probed.clear()
}

export async function probeAudioTracks(
  url: string,
  fetchImpl: typeof fetch = fetch
): Promise<ProbedAudioTrack[]> {
  const cached = probed.get(url)
  if (cached) return cached
  try {
    const res = await fetchImpl('/api/transcode/probeTracks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceUrl: url })
    })
    if (!res.ok) return []
    const data = (await res.json()) as { audioTracks?: { index?: number; codec?: string }[] }
    const tracks = (data.audioTracks ?? [])
      .map((track, position) => ({ index: track.index ?? position, codec: track.codec ?? '' }))
      .sort((a, b) => a.index - b.index)
    probed.set(url, tracks)
    return tracks
  } catch {
    // A failed probe is not evidence of anything: play the stream as we would have anyway.
    return []
  }
}

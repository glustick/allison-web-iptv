import { useRef, useState } from 'react'
import { codecCandidates, extractHevcAnnexB, hevcCodecStringFromAnnexB, splitAccessUnits } from '../lib/tsHevc'
import { saveVerdict } from '../lib/decodeGate'

/**
 * The client-side decode check, in admin -> System.
 *
 * The operator's capability panel answered *whether* WebCodecs can decode this provider's HEVC
 * (`yes`, on the machine with the RTX 3080 Ti). This answers the two questions that decide whether a
 * client-side player is worth building: **how fast**, and **on which path** — hardware or software.
 * A software path that decodes 4K Main 10 at single-digit frames per second would produce a slideshow
 * with a green tick next to it.
 *
 * It runs the exact pipeline the player would use: fetch a live playlist, take one MPEG-TS segment,
 * demux it to Annex-B HEVC with the shipped extractor, and hand it to `VideoDecoder` — configured as
 * `hev1` (parameter sets in-band, which is what Annex-B provides, so no codec description is needed).
 *
 * Two honest limits, stated in the UI rather than hidden:
 * - the whole elementary stream is submitted as one chunk, which measures *throughput* well and frame
 *   *pacing* not at all;
 * - a reader that cannot decode will say so here, which is the point — this is a measurement, not a
 *   fallback.
 */
export function DecoderCheck() {
  const [source, setSource] = useState('/api/stream/live/668.m3u8')
  const [status, setStatus] = useState<string | null>(null)
  const [result, setResult] = useState<string[] | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  async function run(): Promise<void> {
    setResult(null)
    setStatus('checking…')

    const ctor = (
      globalThis as unknown as {
        VideoDecoder?: {
          new (init: { output: (frame: VideoFrame) => void; error: (error: Error) => void }): {
            configure: (config: Record<string, unknown>) => void
            decode: (chunk: unknown) => void
            flush: () => Promise<void>
            close: () => void
          }
          isConfigSupported?: (config: Record<string, unknown>) => Promise<{ supported?: boolean }>
        }
        EncodedVideoChunk?: new (init: { type: 'key' | 'delta'; timestamp: number; data: Uint8Array }) => unknown
      }
    ).VideoDecoder

    if (!ctor || typeof ctor.isConfigSupported !== 'function') {
      setStatus('this browser has no WebCodecs VideoDecoder — nothing to measure')
      return
    }

    try {
      const first = await fetch(source)
      if (!first.ok) {
        setStatus(`that channel answered HTTP ${first.status} — the check cannot measure a channel the server cannot reach`)
        return
      }
      const buffer = new Uint8Array(await first.arrayBuffer())
      // The provider's documented flip: a channel's .m3u8 URL sometimes answers raw MPEG-TS. That is
      // not a failure — the bytes are exactly what the demuxer eats, so the check measures them
      // directly instead of demanding a playlist first.
      const rawTs = buffer.length > 188 && buffer[0] === 0x47 && buffer[188] === 0x47
      let segment: Uint8Array
      if (rawTs) {
        setStatus('that channel answered raw MPEG-TS (the provider\'s HLS-or-TS flip) — measuring the bytes directly…')
        segment = buffer
      } else {
        const playlist = new TextDecoder().decode(buffer)
        const segmentPath = playlist
          .split('\n')
          .map((line) => line.trim())
          .find((line) => line.startsWith('/__fetch/') || line.startsWith('http'))
        if (!segmentPath) {
          // Self-diagnosing: whatever this body is, show its shape — an error page and a variant
          // master playlist read very differently, and the difference was previously invisible.
          const head = playlist.slice(0, 160).replace(/\s+/g, ' ').trim()
          setStatus(
            `that playlist listed no segment — the channel answered ${buffer.length} bytes beginning: "${head}" — ` +
              'the channel may be down, or serving something other than a media playlist'
          )
          return
        }
        setStatus('fetching one segment…')
        const seg = await fetch(segmentPath)
        if (!seg.ok) {
          setStatus(`the segment answered HTTP ${seg.status} — its signature may have expired; re-run the check`)
          return
        }
        segment = new Uint8Array(await seg.arrayBuffer())
      }

      setStatus(`demuxing ${(segment.length / 1_000_000).toFixed(1)} MB of MPEG-TS…`)
      const extracted = extractHevcAnnexB(segment)
      if (!extracted) {
        setStatus('no HEVC video track in that segment — check the channel id')
        return
      }

      // hev1, not hvc1: in-band parameter sets, which is what Annex-B carries, so WebCodecs needs no
      // codec description. The string itself is read from the stream's own SPS (lib/tsHevc.ts), so a
      // Main 10 HDR channel is measured as Main 10 rather than as whatever the last hardcode said.
      let config: { codec: string; hardwareAcceleration: 'prefer-hardware' } | null = null
      for (const candidate of codecCandidates(hevcCodecStringFromAnnexB(extracted.data))) {
        const attempt = { codec: candidate, hardwareAcceleration: 'prefer-hardware' as const }
        // The platform's own answer decides — the derived string first, the provider's two known
        // shapes behind it.
        const support = await ctor.isConfigSupported(attempt)
        if (support.supported) {
          config = attempt
          break
        }
      }
      if (!config) {
        setStatus('the platform refused every HEVC configuration this stream offered — a client-side player would need software fallback')
        return
      }

      let frames = 0
      let shown = 0
      const canvas = canvasRef.current
      const decoder = new ctor({
        output: (frame) => {
          frames += 1
          // Draw the first and last frames: a black canvas with frames counted would be a lie of
          // omission, and a decoded 4K frame on screen is proof the whole chain worked.
          if (canvas && (shown === 0 || frames % 25 === 0)) {
            shown += 1
            canvas.width = frame.displayWidth
            canvas.height = frame.displayHeight
            canvas.getContext('2d')?.drawImage(frame, 0, 0)
          }
          frame.close()
        },
        error: (error) =>
          setStatus(
            `the decoder failed mid-run on ${config?.codec ?? 'the chosen configuration'} (${error.message}) — ` +
              'a finding about this browser build, not the stream or the device'
          )
      })

      const units = splitAccessUnits(extracted.data)
      const unitCount = units.length
      setStatus(`decoding ${unitCount} access units (${(extracted.data.length / 1_000_000).toFixed(2)} MB)…`)
      const started = performance.now()
      const Chunk = (
        globalThis as unknown as {
          EncodedVideoChunk: new (init: {
            type: 'key' | 'delta'
            timestamp: number
            data: Uint8Array
          }) => unknown
        }
      ).EncodedVideoChunk
      // One chunk per frame, which is what a chunk *is* — feeding the whole elementary stream as one
      // produced zero frames on a machine that had been decoding these streams fine (2026-09-28).
      try {
        decoder.configure(config)
        units.forEach((unit, index) => {
          decoder.decode(new Chunk({ type: index === 0 ? 'key' : 'delta', timestamp: index * 20_000, data: unit }))
        })
        await decoder.flush()
      } catch (error) {
        // Measured on Safari 2026-10-01: isConfigSupported says yes, then the decoder answers with a
        // bare "Decoder failure" — WebKit's generic refusal, most likely its VideoDecoder not taking
        // Annex-B HEVC with in-band parameter sets (hev1, no description). That is a fact about the
        // browser, not the stream or the device, and the sentence owes the operator that much.
        try {
          decoder.close()
        } catch {
          // Already dead.
        }
        setStatus(
          `this browser's decoder refused ${config.codec} after claiming support for it ` +
            `(${error instanceof Error ? error.message : String(error)}) — a finding about this browser build, ` +
            'not the stream or the device. The client-side path is built for Chrome, Brave and Edge; ' +
            'Safari plays these channels natively and does not need it.'
        )
        return
      }
      const seconds = (performance.now() - started) / 1000
      decoder.close()

      // Recorded per device (lib/decodeGate.ts) — but only when the run actually produced picture.
      // A failed measurement is not a verdict on the machine, and saving one as "insufficient" would
      // write off a device that was never given a fair test.
      const framesPerSecond = seconds > 0 ? frames / seconds : 0
      const producedPicture = frames > 0 && (canvas?.width ?? 0) > 0 && (canvas?.height ?? 0) > 0
      if (producedPicture) {
        saveVerdict({
          measuredAt: Date.now(),
          framesPerSecond,
          presentedWidth: canvas?.width ?? 0,
          presentedHeight: canvas?.height ?? 0,
          codec: config.codec
        })
      }

      setResult([
        `video PID: ${extracted.pid}`,
        `elementary stream: ${(extracted.data.length / 1_000_000).toFixed(2)} MB in ${unitCount} access units`,
        `decoded frames: ${frames}`,
        `decode speed: ${framesPerSecond.toFixed(1)} frames/second (wall clock, including the first-frame setup)`,
        `presented size: ${canvas?.width ?? 0}x${canvas?.height ?? 0}`,
        `config the platform accepted: ${config.codec} (hardwareAcceleration: prefer-hardware)`,
        producedPicture
          ? 'saved as this device\'s client-decode verdict — it is what the player and the media stats panel read'
          : 'NOT saved: the decoder accepted the configuration but produced no frames, so this run says nothing about the device. Re-run it, and if it repeats, report it as a finding about this browser build.'
      ])
      setStatus(null)
    } catch (error) {
      setStatus(`check failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  return (
    <section className="admin-section">
      <h2>Client-side decode check</h2>
      <p className="setup-hint">
        Runs the pipeline a client-side player would use: fetch a live segment, demux it to Annex-B
        HEVC, and decode it with WebCodecs. Frames per second is the number that matters — hundreds
        means the GPU is doing the work and a client-side player is worth building; single digits would
        mean a slideshow. One chunk per frame, so this measures real decoding. Built for Chrome, Brave
        and Edge — Safari plays these channels natively and does not need this path; a refusal here is
        a finding about Safari&rsquo;s WebCodecs, not about your streams.
      </p>
      <div className="epg-section-actions">
        <input
          type="text"
          value={source}
          onChange={(event) => setSource(event.target.value)}
          aria-label="Stream path to test"
          style={{ minWidth: 320 }}
        />
        <button type="button" className="admin-small-btn" onClick={() => void run()}>
          Run decode check
        </button>
      </div>
      {status && <p className="setup-hint">{status}</p>}
      {result && (
        <ul className="setup-hint">
          {result.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}
      <canvas ref={canvasRef} style={{ maxWidth: '100%', marginTop: 8, background: '#000' }} />
    </section>
  )
}

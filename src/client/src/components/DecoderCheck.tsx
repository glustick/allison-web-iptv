import { useRef, useState } from 'react'
import { extractHevcAnnexB } from '../lib/tsHevc'

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
      const playlist = await (await fetch(source)).text()
      const segmentPath = playlist
        .split('\n')
        .map((line) => line.trim())
        .find((line) => line.startsWith('/__fetch/') || line.startsWith('http'))
      if (!segmentPath) {
        setStatus('that playlist listed no segment — is the channel up?')
        return
      }

      setStatus('fetching one segment…')
      const segment = new Uint8Array(await (await fetch(segmentPath)).arrayBuffer())

      setStatus(`demuxing ${(segment.length / 1_000_000).toFixed(1)} MB of MPEG-TS…`)
      const extracted = extractHevcAnnexB(segment)
      if (!extracted) {
        setStatus('no HEVC video track in that segment — check the channel id')
        return
      }

      // hev1, not hvc1: in-band parameter sets, which is what Annex-B carries, so WebCodecs needs no
      // codec description. Main 10 at level 5.3 is the UHD profile this provider actually serves.
      const config = { codec: 'hev1.1.6.L153.B0', hardwareAcceleration: 'prefer-hardware' as const }
      const support = await ctor.isConfigSupported(config)
      if (!support.supported) {
        setStatus(`the platform refused ${config.codec} — a client-side player would need software fallback`)
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
        error: (error) => setStatus(`decoder error: ${error.message}`)
      })

      setStatus(`decoding ${extracted.data.length} bytes of ${extracted.data.length > 0 ? 'HEVC' : 'nothing'}…`)
      const started = performance.now()
      decoder.configure(config)
      const Chunk = (
        globalThis as unknown as {
          EncodedVideoChunk: new (init: { type: 'key'; timestamp: number; data: Uint8Array }) => unknown
        }
      ).EncodedVideoChunk
      decoder.decode(new Chunk({ type: 'key', timestamp: 0, data: extracted.data }))
      await decoder.flush()
      const seconds = (performance.now() - started) / 1000
      decoder.close()

      setResult([
        `video PID: ${extracted.pid}`,
        `elementary stream: ${(extracted.data.length / 1_000_000).toFixed(2)} MB`,
        `decoded frames: ${frames}`,
        `decode speed: ${(frames / seconds).toFixed(1)} frames/second (wall clock, including the first-frame setup)`,
        `presented size: ${canvas?.width ?? 0}x${canvas?.height ?? 0}`,
        `config the platform accepted: ${config.codec} (hardwareAcceleration: prefer-hardware)`
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
        mean a slideshow. The whole stream is submitted as one chunk, so this measures throughput, not
        frame pacing.
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

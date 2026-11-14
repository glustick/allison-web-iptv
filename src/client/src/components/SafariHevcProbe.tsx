import { useRef, useState } from 'react'

/**
 * The Safari HEVC probe (v0.105.0), in admin -> System.
 *
 * One question has been open since 2026-09-21: **HEVC-in-HLS does not play in Safari in any
 * packaging ffmpeg could produce** (TS and fMP4, with and without audio, with and without a
 * master playlist — playlist, init and first segment all fetch, then no picture), while a plain
 * HEVC MP4 of the same encoder plays fine. So it is either ffmpeg's packaging or the provider's
 * own streams — and deciding needs exactly this: **one real provider segment played in Safari**,
 * through the app's own relay, no ffmpeg anywhere in the path.
 *
 * It is deliberately the browser's OWN pipeline: a plain `<video src>` pointed at a live
 * playlist, muted, autoplaying, for a bounded window. In Safari that exercises native HLS
 * (everything the player's native path does); in Chrome it honestly reports "no native HLS",
 * which is itself the answer for that browser. The verdict records the four facts that settle
 * the question — did metadata arrive, is there a video track, did the playhead advance, and
 * what the browser said if it refused — as copyable lines, because the person reading them is
 * usually not sitting at the machine that produced them.
 */
const PROBE_WINDOW_MS = 15_000

interface VideoElementWithTracks extends HTMLVideoElement {
  videoTracks?: { length: number }
}

export function SafariHevcProbe() {
  const [source, setSource] = useState('/api/stream/live/668.m3u8')
  const [running, setRunning] = useState(false)
  const [lines, setLines] = useState<string[] | null>(null)
  const videoRef = useRef<VideoElementWithTracks | null>(null)

  function log(message: string): void {
    const clock = new Date().toLocaleTimeString()
    setLines((previous) => [...(previous ?? []), `${clock}  ${message}`])
  }

  async function run(): Promise<void> {
    if (running) return
    setLines([])
    setRunning(true)
    log(`probing ${source} in ${navigator.userAgent.includes('Safari/') && !navigator.userAgent.includes('Chrome/') ? 'Safari' : 'this browser'} — the browser's own HLS pipeline, no ffmpeg, no hls.js`)

    const video = document.createElement('video') as VideoElementWithTracks
    videoRef.current = video
    video.muted = true
    video.autoplay = true
    video.playsInline = true
    video.style.position = 'fixed'
    video.style.right = '8px'
    video.style.bottom = '8px'
    video.style.width = '224px'
    video.style.zIndex = '1'
    let settled = false

    const finish = (verdict: string): void => {
      if (settled) return
      settled = true
      log(verdict)
      video.pause()
      video.removeAttribute('src')
      video.load()
      video.remove()
      setRunning(false)
    }

    video.addEventListener('loadedmetadata', () => {
      log(`metadata: ${video.videoWidth}×${video.videoHeight}${video.videoTracks ? `, ${video.videoTracks.length} video track(s)` : ' (this browser does not expose videoTracks)'}`)
    })
    video.addEventListener('canplay', () => log(`canplay (readyState ${video.readyState})`))
    video.addEventListener('error', () => {
      const err = video.error
      // code 3 (decode) with metadata already seen is the exact open question's signature.
      log(`error: ${err ? `MediaError code ${err.code} (${err.message || 'no message'})` : 'element error with no MediaError'}`)
    })

    video.src = source

    // Sample the playhead for the whole window: "metadata then no picture" and "plays" differ
    // only in whether currentTime ever moves, and one sample can land before playback starts.
    const startedAt = performance.now()
    let advancedTo = 0
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, 1000))
      const elapsed = Math.round(performance.now() - startedAt)
      if (settled) return
      advancedTo = Math.max(advancedTo, video.currentTime)
      if (video.currentTime > 0.5 && video.videoWidth > 0) {
        finish(`VERDICT: the picture advanced to ${video.currentTime.toFixed(1)}s at ${video.videoWidth}×${video.videoHeight} — this browser plays the provider's own HEVC HLS packaging.`)
        return
      }
      if (elapsed >= PROBE_WINDOW_MS) break
      if (elapsed % 5000 < 1000) log(`${elapsed}s: readyState ${video.readyState}, playhead ${video.currentTime.toFixed(1)}s`)
    }
    if (video.videoWidth > 0) {
      finish(`VERDICT: metadata arrived but the playhead never advanced (stuck at ${advancedTo.toFixed(1)}s) — the packaging loads and does not play.`)
    } else {
      finish('VERDICT: no metadata within the window — this browser would not even load the stream (expected in Chrome, which has no native HLS; the question this probe answers is Safari\'s).')
    }
  }

  return (
    <section className="admin-section">
      <div className="epg-section-head">
        <h2>Safari HEVC probe</h2>
        <button type="button" className="admin-small-btn" onClick={() => void run()} disabled={running}>
          {running ? 'Probing…' : 'Play one real stream'}
        </button>
      </div>
      <p className="setup-hint">
        Plays a real provider playlist through the app's own relay in the browser's native HLS
        pipeline — no ffmpeg, no hls.js. Settles whether Safari plays the provider's own HEVC
        packaging (the open question since September: every ffmpeg packaging fetched fine but
        showed no picture). Run it in Safari; Chrome honestly answers "no native HLS". Muted,
        15 seconds, bottom-right corner, with a copyable verdict.
      </p>
      <div className="epg-section-actions">
        <input
          type="text"
          value={source}
          onChange={(event) => setSource(event.target.value)}
          aria-label="Live channel path to play"
          style={{ minWidth: 320 }}
          spellCheck={false}
        />
      </div>
      {lines !== null && (
        <div className="admin-table-wrap">
          <table className="admin-table">
            <tbody>
              {lines.map((line, index) => (
                <tr key={index}>
                  <td>{line}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

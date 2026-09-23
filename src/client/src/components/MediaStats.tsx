import { useEffect, useState } from 'react'

interface MediaStatsProps {
  video: HTMLVideoElement | null
  engine: 'native' | 'hls' | null
  videoCodec: string | null
  audioTrackCount: number | null
  /** The player's bandwidth estimate, where its engine provides one (hls.js does). */
  readBandwidth: () => number | null
}

interface CapabilityRow {
  label: string
  value: string
}

interface LiveRow {
  label: string
  value: string
}

const UNKNOWN = 'unknown'

function mbps(bitsPerSecond: number | null | undefined): string {
  if (!Number.isFinite(bitsPerSecond as number)) return UNKNOWN
  return `${(Math.round((bitsPerSecond as number) / 10000) / 100).toFixed(2)} Mbps`
}

/**
 * The live player's own diagnostics, on the operator's request (2026-09-22): what engine is running,
 * what the stream is, and what this browser can actually do — so that "why is it black?" is answered by
 * reading rather than by guessing.
 *
 * Two rules this component keeps:
 * 1. **Nothing is invented.** A capability the platform does not expose is reported as `unknown`
 *    (hardware-vs-software decode for a plain `<video>` element has no API, and saying otherwise would
 *    be a lie wearing a badge).
 * 2. **The panel is only live while it is open** — a one-second interval, cleared on close — so it
 *    never competes with the thing it is measuring.
 */
export function MediaStats({ video, engine, videoCodec, audioTrackCount, readBandwidth }: MediaStatsProps) {
  const [capabilities, setCapabilities] = useState<CapabilityRow[]>([])
  const [live, setLive] = useState<LiveRow[]>([])

  // Capabilities: computed once when the panel opens. The WebCodecs answer is asynchronous, so it
  // lands as an update to its row rather than blocking the rest.
  useEffect(() => {
    let cancelled = false

    const nativeHls = (() => {
      try {
        const answer = video?.canPlayType('application/vnd.apple.mpegurl') ?? ''
        return answer === '' ? 'no' : `yes (${answer})`
      } catch {
        return UNKNOWN
      }
    })()

    const mseHevc = (() => {
      try {
        return typeof MediaSource !== 'undefined' &&
          MediaSource.isTypeSupported('video/mp4;codecs="hvc1.1.6.L153.B0"')
          ? 'yes'
          : 'no'
      } catch {
        return UNKNOWN
      }
    })()

    setCapabilities([
      { label: 'Native HLS pipeline', value: nativeHls },
      { label: 'MSE accepts HEVC (hvc1 in fMP4)', value: mseHevc },
      { label: 'WebCodecs available', value: typeof (globalThis as Record<string, unknown>).VideoDecoder === 'function' ? 'yes' : 'no' },
      { label: 'WebCodecs HEVC decode (4K Main 10, prefer hardware)', value: 'checking…' }
    ])

    const webCodecs = (globalThis as unknown as {
      VideoDecoder?: { isConfigSupported?: (config: Record<string, unknown>) => Promise<{ supported?: boolean; config?: { hardwareAcceleration?: string } }> }
    }).VideoDecoder

    if (typeof webCodecs?.isConfigSupported !== 'function') {
      setCapabilities((rows) =>
        rows.map((row) =>
          row.label === 'WebCodecs HEVC decode (4K Main 10, prefer hardware)'
            ? { ...row, value: 'unavailable' }
            : row
        )
      )
      return
    }

    void webCodecs
      .isConfigSupported({
        codec: 'hvc1.1.6.L153.B0',
        codedWidth: 3840,
        codedHeight: 2160,
        hardwareAcceleration: 'prefer-hardware'
      })
      .then((result) => {
        if (cancelled) return
        // The answer names the path the browser chose: hardware here means the GPU the operator asked
        // about; "require-software" would mean the decode cannot be offloaded.
        const path = result.config?.hardwareAcceleration ?? 'unknown'
        setCapabilities((rows) =>
          rows.map((row) =>
            row.label === 'WebCodecs HEVC decode (4K Main 10, prefer hardware)'
              ? { ...row, value: result.supported ? `yes (${path})` : 'no' }
              : row
          )
        )
      })
      .catch(() => {
        if (cancelled) return
        setCapabilities((rows) =>
          rows.map((row) =>
            row.label === 'WebCodecs HEVC decode (4K Main 10, prefer hardware)'
              ? { ...row, value: UNKNOWN }
              : row
          )
        )
      })

    return () => {
      cancelled = true
    }
    // Capabilities are read once, when the panel opens: they describe the browser and the element,
    // not the moment, so re-reading them on every render would be noise.
  }, [])

  // Live numbers, once a second, only while open.
  useEffect(() => {
    const timer = setInterval(() => {
      if (!video) {
        setLive([])
        return
      }

      let bufferedAhead = 0
      for (let i = 0; i < video.buffered.length; i += 1) {
        if (video.buffered.start(i) <= video.currentTime && video.currentTime <= video.buffered.end(i)) {
          bufferedAhead = video.buffered.end(i) - video.currentTime
        }
      }

      const quality =
        typeof video.getVideoPlaybackQuality === 'function' ? video.getVideoPlaybackQuality() : null

      setLive([
        { label: 'Presented resolution', value: video.videoWidth > 0 ? `${video.videoWidth}x${video.videoHeight}` : 'none' },
        { label: 'Played', value: `${video.currentTime.toFixed(1)}s` },
        { label: 'Buffered ahead', value: `${bufferedAhead.toFixed(1)}s` },
        { label: 'Dropped frames', value: quality ? `${quality.droppedVideoFrames} of ${quality.totalVideoFrames}` : UNKNOWN },
        { label: 'Bandwidth estimate', value: mbps(readBandwidth()) }
      ])
    }, 1000)

    return () => clearInterval(timer)
  }, [video, readBandwidth])

  const engineLabel = engine === 'native' ? 'native HLS' : engine === 'hls' ? 'hls.js (MSE)' : 'starting'

  return (
    <div
      style={{
        // A flow child of the player's overlay container (see LivePlayer): positioned by that, never
        // itself, so the toggle and this panel stay in one stack.
        maxWidth: 320,
        maxHeight: '45vh',
        overflow: 'hidden',
        padding: '10px 12px',
        borderRadius: 8,
        background: 'rgba(10, 14, 20, 0.88)',
        color: '#e6edf3',
        fontSize: 12,
        lineHeight: 1.5,
        textAlign: 'left',
        pointerEvents: 'none'
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: 6 }}>Media stats</div>
      <div><strong>Engine:</strong> {engineLabel}</div>
      <div><strong>Stream video codec:</strong> {videoCodec ?? UNKNOWN}</div>
      <div><strong>Audio tracks:</strong> {audioTrackCount ?? UNKNOWN}</div>
      <div style={{ marginTop: 6, fontWeight: 600 }}>This browser</div>
      {capabilities.map((row) => (
        <div key={row.label}><strong>{row.label}:</strong> {row.value}</div>
      ))}
      {live.length > 0 && (
        <div style={{ marginTop: 6, fontWeight: 600 }}>Live</div>
      )}
      {live.map((row) => (
        <div key={row.label}><strong>{row.label}:</strong> {row.value}</div>
      ))}
    </div>
  )
}

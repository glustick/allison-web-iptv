import type { JSX } from 'react'

export interface PlayerTrack {
  index: number
  name?: string
  lang?: string
  default?: boolean
}

function trackLabel(track: PlayerTrack, fallback: string): string {
  return track.name || track.lang || `${fallback} ${track.index + 1}`
}

export function TrackControls({
  audioTracks,
  audioTrack,
  onAudioChange,
  subtitleTracks,
  subtitleTrack,
  onSubtitleChange
}: {
  audioTracks: PlayerTrack[]
  audioTrack: number
  onAudioChange: (index: number) => void
  subtitleTracks: PlayerTrack[]
  subtitleTrack: number
  onSubtitleChange: (index: number) => void
}): JSX.Element | null {
  if (audioTracks.length <= 1 && subtitleTracks.length === 0) return null

  return (
    <div className="track-controls" aria-label="Playback tracks">
      {audioTracks.length > 1 && (
        <label>
          Audio
          <select value={audioTrack} onChange={(event) => onAudioChange(Number(event.target.value))}>
            {audioTracks.map((track) => (
              <option key={track.index} value={track.index}>{trackLabel(track, 'Audio')}</option>
            ))}
          </select>
        </label>
      )}
      {subtitleTracks.length > 0 && (
        <label>
          Subtitles
          <select value={subtitleTrack} onChange={(event) => onSubtitleChange(Number(event.target.value))}>
            <option value={-1}>Off</option>
            {subtitleTracks.map((track) => (
              <option key={track.index} value={track.index}>{trackLabel(track, 'Subtitle')}</option>
            ))}
          </select>
        </label>
      )}
    </div>
  )
}
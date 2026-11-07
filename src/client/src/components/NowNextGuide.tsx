import { useEffect, useState, type JSX } from 'react'
import { clockLabel, pickNowNext, programmeProgress, type GuideProgramme } from '../lib/guideNowNext'

/**
 * What is on this channel now, and what follows (v0.91.0).
 *
 * Placed under the player rather than in the guide: the guide answers "what could I watch", this
 * answers "what am I watching, and what is it cutting into". It re-renders once a minute — enough
 * for the progress bar's resolution, and nothing that competes with playback.
 */
export function NowNextGuide({ programmes }: { programmes: GuideProgramme[] }): JSX.Element | null {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(timer)
  }, [])

  const { current, next } = pickNowNext(programmes, now)
  if (!current && !next) return null

  return (
    <div className="now-next" aria-label="What's on this channel">
      {current ? (
        <>
          <div className="now-next-row">
            <span className="now-next-label">Now</span>
            <span className="now-next-title">{current.title}</span>
            <span className="now-next-time">
              {clockLabel(current.startMs)}–{clockLabel(current.stopMs)}
            </span>
          </div>
          <div className="now-next-bar">
            <div className="now-next-bar-fill" style={{ width: `${Math.round(programmeProgress(current, now) * 100)}%` }} />
          </div>
        </>
      ) : (
        <div className="now-next-row">
          <span className="now-next-label">Now</span>
          <span className="now-next-title now-next-empty">No programme data for this channel</span>
        </div>
      )}
      {next && (
        <div className="now-next-row now-next-next">
          <span className="now-next-label">Next</span>
          <span className="now-next-title">{next.title}</span>
          <span className="now-next-time">{clockLabel(next.startMs)}</span>
        </div>
      )}
    </div>
  )
}

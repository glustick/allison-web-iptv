import { useState, type ReactElement, type ReactNode } from 'react'

/**
 * One small button in the corner, and the player's overlays behind it.
 *
 * The stack used to be permanently on screen — quality, PiP, ±10s, stats, subtitles, sleep — a
 * vertical strip down the right edge of the picture. On a phone that is a large part of the video
 * that cannot be pressed to show the browser's own controls or enter fullscreen, and even on a
 * desktop it sits over the picture for no reason while nothing is being adjusted.
 *
 * Collapsed by default now: the picture is the thing you press, and this one button is the only
 * thing that intercepts a press. Opening it lays the same controls out in the same order — the
 * fix is where they live, not what they do.
 */
export function PlayerMenu({ children }: { children: ReactNode }): ReactElement {
  const [open, setOpen] = useState(false)
  return (
    <div className="player-menu">
      <button
        type="button"
        className="admin-small-btn player-menu-toggle"
        aria-expanded={open}
        title={open ? 'Hide the player controls' : 'Show the player controls'}
        onClick={() => setOpen((value) => !value)}
      >
        <span aria-hidden="true">{open ? '✕' : '⚙'}</span>
        <span className="player-menu-label">{open ? 'Hide' : 'Controls'}</span>
      </button>
      {open && <div className="player-menu-panel">{children}</div>}
    </div>
  )
}

import { useEffect, useId, useState, type CSSProperties, type JSX } from 'react'
import { SLEEP_PRESETS, formatCountdown, type SleepTimer } from '../lib/sleepTimer'
import { clockLabel, pickNowNext, type GuideProgramme } from '../lib/guideNowNext'

const PANEL: CSSProperties = {
  width: 228,
  padding: '10px 12px',
  borderRadius: 8,
  background: 'rgba(10, 14, 20, 0.92)',
  color: '#e6edf3',
  fontSize: 12,
  lineHeight: 1.5,
  textAlign: 'left',
  pointerEvents: 'auto'
}

/**
 * The sleep timer's control, in the player's overlay stack beside Subtitles (v0.90.0).
 *
 * It shows the countdown on the button itself while a timer is armed — the one piece of state a
 * viewer needs to see without opening anything ("is it still on?").
 */
export function SleepTimerButton({
  timer,
  remaining,
  onStart,
  onStartAt,
  onCancel,
  programmes
}: {
  timer: SleepTimer | null
  remaining: number
  onStart: (minutes: number) => void
  onStartAt: (endsAt: number, label?: string) => void
  onCancel: () => void
  /** The channel's schedule, when the caller has it — enables "end of this programme". */
  programmes?: GuideProgramme[]
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const panelId = useId()

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  return (
    <div>
      <button
        type="button"
        className="admin-small-btn"
        style={{ padding: '4px 8px' }}
        aria-expanded={open}
        aria-controls={panelId}
        title="Stop playback after a set time."
        onClick={() => setOpen((value) => !value)}
      >
        {timer ? `Sleep ${formatCountdown(remaining)}` : 'Sleep'}
      </button>
      {open && (
        <div id={panelId} role="group" aria-label="Sleep timer" style={PANEL}>
          <div style={{ fontWeight: 600 }}>Sleep timer</div>
          {(() => {
            // Computed when the panel renders, not when the player mounted: the programme that is
            // on now is the one the viewer means, and it may have changed since the last channel.
            const current = programmes ? pickNowNext(programmes, Date.now()).current : null
            if (!current) return null
            const label = `End of programme (${clockLabel(current.stopMs)})`
            return (
              <div style={{ display: 'flex', marginTop: 6 }}>
                <button
                  type="button"
                  className="admin-small-btn"
                  style={{ padding: '2px 7px', fontSize: 11 }}
                  aria-pressed={timer?.label === 'End of programme'}
                  title={`Stop when ${current.title} ends at ${clockLabel(current.stopMs)}`}
                  onClick={() => onStartAt(current.stopMs, 'End of programme')}
                >
                  {label}
                </button>
              </div>
            )
          })()}
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 6 }}>
            {SLEEP_PRESETS.map((minutes) => (
              <button
                key={minutes}
                type="button"
                className="admin-small-btn"
                aria-pressed={timer?.minutes === minutes}
                style={{
                  padding: '2px 7px',
                  fontSize: 11,
                  borderColor: timer?.minutes === minutes ? '#58a6ff' : undefined,
                  color: timer?.minutes === minutes ? '#dbeafe' : undefined
                }}
                onClick={() => onStart(minutes)}
              >
                {minutes} min
              </button>
            ))}
          </div>
          {timer && (
            <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={{ opacity: 0.8 }}>Stops in {formatCountdown(remaining)}</span>
              <button type="button" className="admin-small-btn" style={{ padding: '2px 7px', fontSize: 11 }} onClick={onCancel}>
                Cancel
              </button>
            </div>
          )}
          <div style={{ marginTop: 8, opacity: 0.65 }}>
            When it reaches zero, playback stops and the player closes — which also releases this
            account&apos;s provider connection.
          </div>
        </div>
      )}
    </div>
  )
}

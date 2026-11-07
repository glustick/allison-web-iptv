import { useEffect, useState, type JSX } from 'react'
import {
  REMINDERS_EVENT,
  dueReminders,
  markFired,
  readReminders,
  writeReminders,
  type Reminder
} from '../lib/reminders'

/**
 * The one place a reminder becomes something you can see (v0.91.0).
 *
 * Mounted in the app shell rather than in the guide, because a reminder set in the guide is
 * exactly the one you will be watching something else when it fires. It ticks every 15 seconds —
 * a reminder that arrives up to 15 seconds late is still a minute ahead of the programme — and
 * also re-checks on every reminder write, so setting one for a programme that is already starting
 * fires immediately rather than at the next tick.
 *
 * The browser notification is a bonus, never the mechanism: permission may be denied, and the
 * in-app banner is the one that always appears. A reminder is marked fired **before** the banner
 * is shown, so a reload mid-banner cannot produce a second one.
 */
export function ReminderWatcher({ onWatch }: { onWatch: (reminder: Reminder) => void }): JSX.Element | null {
  const [firing, setFiring] = useState<Reminder | null>(null)

  useEffect(() => {
    const check = (): void => {
      const list = readReminders()
      const due = dueReminders(list, Date.now())[0]
      if (!due) return
      writeReminders(markFired(list, due.id, Date.now()))
      setFiring(due)
      try {
        if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
          new Notification(`Starting now: ${due.title}`, { body: due.channelName, tag: due.id })
        }
      } catch {
        // Some platforms forbid constructing a Notification from a page without a service worker;
        // the banner has already been shown, so nothing else is needed.
      }
    }
    check()
    const timer = window.setInterval(check, 15_000)
    window.addEventListener(REMINDERS_EVENT, check)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener(REMINDERS_EVENT, check)
    }
  }, [])

  if (!firing) return null
  return (
    <div className="reminder-banner" role="status">
      <div className="reminder-banner-main">
        <strong>{firing.title}</strong>
        <span className="reminder-banner-meta">on {firing.channelName} — starting now</span>
      </div>
      <div className="reminder-banner-actions">
        <button
          type="button"
          className="admin-small-btn"
          onClick={() => {
            onWatch(firing)
            setFiring(null)
          }}
        >
          Watch
        </button>
        <button type="button" className="admin-small-btn" onClick={() => setFiring(null)}>
          Dismiss
        </button>
      </div>
    </div>
  )
}

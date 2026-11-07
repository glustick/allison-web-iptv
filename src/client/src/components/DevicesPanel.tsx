import { useCallback, useEffect, useState, type JSX } from 'react'
import { describeAddress, describeAge, describeUserAgent } from '../lib/deviceLabel'
import { describeAuthOutcome } from '../lib/authActivity'

interface DeviceSession {
  tokenHash: string
  loginAt: number
  lastSeenAt: number
  userAgent: string | null
  ip: string | null
  current: boolean
}

interface ActivityEntry {
  at: string
  outcome: string
  ip: string
  userAgent: string
}

/**
 * Account activity (v0.90.0): where this account is signed in, and what has happened to it lately.
 *
 * The first list is short by design — the operator's rule is one active sign-in per account, and
 * signing in elsewhere ends the others — so the panel does not pretend to be a device manager.
 * What it does answer is the question that rule creates: *was that me?* The audit trail has held
 * the answer since v0.83.0, but only an admin could read it; this is the same rows, filtered to
 * the caller, and it is the first place a household user can see a string of failed attempts
 * against their own password.
 */
export function DevicesPanel({ onClose }: { onClose: () => void }): JSX.Element {
  const [sessions, setSessions] = useState<DeviceSession[] | null>(null)
  const [entries, setEntries] = useState<ActivityEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(async (): Promise<void> => {
    try {
      const [sessionsRes, activityRes] = await Promise.all([fetch('/api/auth/sessions'), fetch('/api/auth/activity')])
      const sessionsData = (await sessionsRes.json()) as { sessions?: DeviceSession[]; error?: string }
      const activityData = (await activityRes.json()) as { entries?: ActivityEntry[]; error?: string }
      if (!sessionsRes.ok) throw new Error(sessionsData.error ?? 'Could not read your sign-ins')
      if (!activityRes.ok) throw new Error(activityData.error ?? 'Could not read your account activity')
      setSessions(sessionsData.sessions ?? [])
      setEntries(activityData.entries ?? [])
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not read your account activity')
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const end = async (tokenHash: string): Promise<void> => {
    setBusy(tokenHash)
    setError(null)
    try {
      const res = await fetch(`/api/auth/sessions/${encodeURIComponent(tokenHash)}/logout`, { method: 'POST' })
      const data = (await res.json()) as { ok?: boolean; current?: boolean; error?: string }
      if (!res.ok) throw new Error(data.error ?? 'Could not end that sign-in')
      // Ending the sign-in in your hand is a sign-out; a reload is the honest way to show it.
      if (data.current) {
        window.location.reload()
        return
      }
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not end that sign-in')
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="multiview-picker-overlay" onClick={onClose}>
      <div className="multiview-picker devices-panel" onClick={(event) => event.stopPropagation()} role="dialog" aria-label="Account activity">
        <div className="multiview-picker-head">
          <strong>Account activity</strong>
          <button type="button" className="admin-small-btn" onClick={onClose}>
            Close
          </button>
        </div>
        <p className="setup-hint" style={{ margin: '6px 0 4px' }}>
          One sign-in is active at a time — signing in on another device ends the previous one. A
          failed attempt you do not recognise means someone is guessing this account&apos;s password.
        </p>
        {error && <div className="login-error">{error}</div>}

        <div className="device-section">Signed in now</div>
        {!sessions && !error && <div className="setup-hint">Reading your sign-ins…</div>}
        {sessions?.length === 0 && <div className="setup-hint">No active sign-ins.</div>}
        {sessions?.map((session) => (
          <div className="device-row" key={session.tokenHash}>
            <div className="device-main">
              <span className="device-name">
                {describeUserAgent(session.userAgent)}
                {session.current && <span className="device-current"> · this device</span>}
              </span>
              <span className="device-meta">
                {describeAddress(session.ip)} · signed in {describeAge(session.loginAt)} · last active {describeAge(session.lastSeenAt)}
              </span>
            </div>
            <button
              type="button"
              className="admin-small-btn"
              disabled={busy === session.tokenHash}
              onClick={() => void end(session.tokenHash)}
            >
              {session.current ? 'Sign out' : busy === session.tokenHash ? 'Ending…' : 'End'}
            </button>
          </div>
        ))}

        <div className="device-section">Recent activity</div>
        {!entries && !error && <div className="setup-hint">Reading your activity…</div>}
        {entries?.length === 0 && <div className="setup-hint">Nothing recorded yet.</div>}
        <div className="activity-list">
          {entries?.map((entry, index) => {
            const outcome = describeAuthOutcome(entry.outcome)
            return (
              <div className="activity-row" key={`${entry.at}:${index}`}>
                <span className={`activity-badge tone-${outcome.tone}`}>{outcome.label}</span>
                <span className="device-meta">
                  {describeAge(Date.parse(entry.at))} · {describeAddress(entry.ip)} · {describeUserAgent(entry.userAgent)}
                </span>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

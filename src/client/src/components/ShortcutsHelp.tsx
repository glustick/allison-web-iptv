import { useEffect, type CSSProperties, type JSX } from 'react'

const PANEL: CSSProperties = {
  position: 'absolute',
  left: 8,
  bottom: 8,
  zIndex: 45,
  padding: '10px 12px',
  borderRadius: 8,
  background: 'rgba(10, 14, 20, 0.92)',
  color: '#e6edf3',
  fontSize: 12,
  lineHeight: 1.6,
  textAlign: 'left',
  pointerEvents: 'auto'
}

const KEY: CSSProperties = {
  display: 'inline-block',
  minWidth: 18,
  padding: '0 5px',
  marginRight: 8,
  borderRadius: 4,
  border: '1px solid rgba(230, 237, 243, 0.28)',
  textAlign: 'center',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: 11
}

function Row({ keys, action }: { keys: string; action: string }): JSX.Element {
  return (
    <div>
      <span style={KEY}>{keys}</span>
      {action}
    </div>
  )
}

/**
 * The shortcut list, opened by `?` or by the button beside it (v0.90.0). Hidden by default: a
 * permanent legend would be clutter on a television screen, and the one person who needs it can
 * ask for it.
 */
export function ShortcutsHelp({ open, seekable, onClose }: { open: boolean; seekable: boolean; onClose: () => void }): JSX.Element | null {
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' || event.key === '?') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null
  return (
    <div style={PANEL} role="dialog" aria-label="Keyboard shortcuts">
      <div style={{ fontWeight: 600, marginBottom: 4 }}>Keyboard shortcuts</div>
      <Row keys="Space" action="play or pause" />
      <Row keys="K" action="play or pause" />
      {seekable && <Row keys="← →" action="10 seconds back or forward" />}
      <Row keys="↑ ↓" action="volume" />
      <Row keys="M" action="mute" />
      <Row keys="F" action="fullscreen" />
      <Row keys="?" action="this list" />
      <button type="button" className="admin-small-btn" style={{ marginTop: 6, padding: '2px 7px', fontSize: 11 }} onClick={onClose}>
        Close
      </button>
    </div>
  )
}

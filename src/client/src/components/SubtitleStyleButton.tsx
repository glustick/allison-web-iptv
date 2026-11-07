import { useEffect, useId, useState, type CSSProperties, type JSX } from 'react'
import {
  CUE_TEXT_COLORS,
  DEFAULT_SUBTITLE_STYLE,
  SUBTITLE_BACKGROUND_PRESETS,
  SUBTITLE_SIZE_PRESETS,
  type CueTextColor,
  type SubtitleStyle
} from '../lib/subtitleStyle'

const PANEL: CSSProperties = {
  // Wide enough for the five size presets on one row — they wrap into a ragged second line at 236.
  width: 268,
  padding: '10px 12px',
  borderRadius: 8,
  background: 'rgba(10, 14, 20, 0.92)',
  color: '#e6edf3',
  fontSize: 12,
  lineHeight: 1.5,
  textAlign: 'left',
  pointerEvents: 'auto'
}

const ROW: CSSProperties = { display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap', marginTop: 6 }

function Choice({
  active,
  label,
  onClick
}: {
  active: boolean
  label: string
  onClick: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      className="admin-small-btn"
      aria-pressed={active}
      onClick={onClick}
      style={{
        padding: '2px 7px',
        fontSize: 11,
        // The pressed state is a border, not a background: these sit on a dark translucent panel,
        // where a filled button would read as the panel's own chrome rather than a chosen value.
        borderColor: active ? '#58a6ff' : undefined,
        color: active ? '#dbeafe' : undefined
      }}
    >
      {label}
    </button>
  )
}

/**
 * The caption-appearance control, beside the player's other overlays (v0.89.0).
 *
 * Every control here maps to a `::cue` property the browser actually honours — size, colour, the
 * box behind the text, the outline — and the panel is deliberately silent about position, which
 * belongs to the native cue renderer (see lib/subtitleStyle.ts for the measurement that decided
 * each one). Shown whether or not this stream carries subtitles: it is a preference about the
 * viewer's eyes, and setting it before turning a track on is the natural order.
 */
export function SubtitleStyleButton({
  style,
  onChange
}: {
  style: SubtitleStyle
  onChange: (next: SubtitleStyle) => void
}): JSX.Element {
  const [open, setOpen] = useState(false)
  // Two players can be mounted at once (the live tab stays alive behind another tab), so the id has
  // to be unique per instance or `aria-controls` would point at whichever panel the browser saw first.
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
        title="How subtitles look — size, colour and the box behind the text."
        onClick={() => setOpen((value) => !value)}
      >
        Subtitles
      </button>
      {open && (
        <div id={panelId} role="group" aria-label="Subtitle appearance" style={PANEL}>
          <div style={{ fontWeight: 600 }}>Subtitle appearance</div>

          <div style={ROW}>
            <span style={{ opacity: 0.75 }}>Size</span>
            {SUBTITLE_SIZE_PRESETS.map((size) => (
              <Choice
                key={size}
                active={style.sizePercent === size}
                label={`${size}%`}
                onClick={() => onChange({ ...style, sizePercent: size })}
              />
            ))}
          </div>

          <div style={ROW}>
            <span style={{ opacity: 0.75 }}>Text</span>
            {(Object.keys(CUE_TEXT_COLORS) as CueTextColor[]).map((color) => (
              <Choice
                key={color}
                active={style.color === color}
                label={color[0].toUpperCase() + color.slice(1)}
                onClick={() => onChange({ ...style, color })}
              />
            ))}
          </div>

          <div style={ROW}>
            <span style={{ opacity: 0.75 }}>Background</span>
            {SUBTITLE_BACKGROUND_PRESETS.map((preset) => (
              <Choice
                key={preset.label}
                active={style.backgroundOpacity === preset.opacity}
                label={preset.label}
                onClick={() => onChange({ ...style, backgroundOpacity: preset.opacity })}
              />
            ))}
          </div>

          <div style={ROW}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={style.outline}
                onChange={(event) => onChange({ ...style, outline: event.target.checked })}
              />
              Outline the text
            </label>
          </div>

          <div style={{ ...ROW, marginTop: 8, justifyContent: 'space-between', alignItems: 'center' }}>
            <Choice
              active={false}
              label="Reset"
              onClick={() => onChange(DEFAULT_SUBTITLE_STYLE)}
            />
            <button type="button" className="admin-small-btn" style={{ padding: '2px 7px', fontSize: 11 }} onClick={() => setOpen(false)}>
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

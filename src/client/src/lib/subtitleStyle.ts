/**
 * How the viewer wants subtitles to look — per device, like every other playback choice.
 *
 * Subtitles here are the browser's own cue rendering: hls.js hands the WebVTT to the media
 * element and the element paints the cues itself. That leaves exactly one surface to style,
 * `video::cue`, and that pseudo-element honours a narrow set — colour, background, font size,
 * a text shadow — and nothing at all about position. So this module carries precisely what the
 * renderer can honour: every control in the panel maps to a property that measurably changes the
 * picture, and no control is offered that would be a decorative lie.
 *
 * Size is a **percentage of the size the browser would have used**, not a pixel value. Measured in
 * Chrome, 2026-11-07 (a 420px-wide test clip with a real WebVTT track): 200% renders at double the
 * default cue's size, and the default itself scales with the picture — so the percentage survives a
 * resize, a fullscreen switch and a different screen. A pixel size would be right on exactly one of
 * those.
 *
 * Position is deliberately absent. Native cue placement belongs to the renderer (and to the cue's
 * own line settings in the stream); a "subtitles lower" slider would change nothing and look broken.
 */

/** The text colours offered, as the panel's own names — the hex is an implementation detail. */
export const CUE_TEXT_COLORS = {
  white: '#ffffff',
  yellow: '#ffe066',
  cyan: '#7fe3ff'
} as const

export type CueTextColor = keyof typeof CUE_TEXT_COLORS

export interface SubtitleStyle {
  /** Percentage of the browser's own cue size, 75–200. */
  sizePercent: number
  color: CueTextColor
  /** Opacity of the black box behind the text, 0–100. */
  backgroundOpacity: number
  /** A black rim around each glyph — what keeps white text legible over a bright scene. */
  outline: boolean
}

export const SUBTITLE_SIZE_PRESETS = [75, 100, 125, 150, 200] as const

export const SUBTITLE_BACKGROUND_PRESETS = [
  { label: 'None', opacity: 0 },
  { label: 'Light', opacity: 45 },
  { label: 'Solid', opacity: 85 }
] as const

export const DEFAULT_SUBTITLE_STYLE: SubtitleStyle = {
  sizePercent: 100,
  color: 'white',
  backgroundOpacity: 45,
  outline: true
}

/**
 * A four-point rim plus a soft drop shadow. Four offsets rather than one shadow because a single
 * blurred shadow disappears against a bright, busy picture — the failure mode this exists for.
 */
const OUTLINE_SHADOW =
  '-1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000, 0 2px 5px rgba(0, 0, 0, 0.9)'

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/**
 * Anything read back from storage — or from a hand-edited localStorage entry — becomes a style the
 * renderer can actually use. Unknown colours read as white, out-of-range numbers clamp, and a
 * non-number falls back to the default rather than producing `NaN%` in a CSS custom property
 * (which fails silently: the browser drops the declaration and the cue keeps its old size).
 */
export function normalizeSubtitleStyle(value: unknown): SubtitleStyle {
  if (!value || typeof value !== 'object') return DEFAULT_SUBTITLE_STYLE
  const raw = value as Partial<SubtitleStyle>
  const size =
    typeof raw.sizePercent === 'number' && Number.isFinite(raw.sizePercent)
      ? Math.round(clamp(raw.sizePercent, 75, 200))
      : DEFAULT_SUBTITLE_STYLE.sizePercent
  const background =
    typeof raw.backgroundOpacity === 'number' && Number.isFinite(raw.backgroundOpacity)
      ? Math.round(clamp(raw.backgroundOpacity, 0, 100))
      : DEFAULT_SUBTITLE_STYLE.backgroundOpacity
  const color =
    typeof raw.color === 'string' && raw.color in CUE_TEXT_COLORS
      ? (raw.color as CueTextColor)
      : DEFAULT_SUBTITLE_STYLE.color
  return {
    sizePercent: size,
    color,
    backgroundOpacity: background,
    outline: raw.outline !== false
  }
}

/**
 * The CSS custom properties the stylesheet's `video::cue` rule reads. Values only — writing them is
 * `applySubtitleStyle`'s job — so the mapping is testable without a DOM.
 */
export function subtitleStyleVars(style: SubtitleStyle): Record<string, string> {
  const normalized = normalizeSubtitleStyle(style)
  return {
    '--cue-size': `${normalized.sizePercent}%`,
    '--cue-color': CUE_TEXT_COLORS[normalized.color],
    // `transparent` rather than `rgba(0,0,0,0)`: some renderers still paint a box for a zero-alpha
    // colour and only skip it for `transparent`.
    '--cue-bg':
      normalized.backgroundOpacity === 0
        ? 'transparent'
        : `rgba(0, 0, 0, ${(normalized.backgroundOpacity / 100).toFixed(2)})`,
    '--cue-shadow': normalized.outline ? OUTLINE_SHADOW : 'none'
  }
}

/**
 * Write the style onto a root element. `document.documentElement` by default, so a single set of
 * variables covers the live player, VOD, and every multi-view tile at once — and survives the
 * player being unmounted and remounted (a channel change keeps the choice without re-applying it).
 */
export function applySubtitleStyle(
  style: SubtitleStyle,
  root: HTMLElement | null = typeof document === 'undefined' ? null : document.documentElement
): void {
  if (!root) return
  for (const [name, value] of Object.entries(subtitleStyleVars(style))) {
    root.style.setProperty(name, value)
  }
}

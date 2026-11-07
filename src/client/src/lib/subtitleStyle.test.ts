import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SUBTITLE_STYLE,
  applySubtitleStyle,
  normalizeSubtitleStyle,
  subtitleStyleVars
} from './subtitleStyle'

describe('subtitle style', () => {
  it('keeps a well-formed style exactly as it is', () => {
    const style = { sizePercent: 150, color: 'yellow' as const, backgroundOpacity: 85, outline: false }
    expect(normalizeSubtitleStyle(style)).toEqual(style)
  })

  it('clamps a size to the range the panel offers, so a stale value cannot make a cue enormous', () => {
    expect(normalizeSubtitleStyle({ ...DEFAULT_SUBTITLE_STYLE, sizePercent: 400 }).sizePercent).toBe(200)
    expect(normalizeSubtitleStyle({ ...DEFAULT_SUBTITLE_STYLE, sizePercent: 10 }).sizePercent).toBe(75)
    expect(normalizeSubtitleStyle({ ...DEFAULT_SUBTITLE_STYLE, sizePercent: 137.6 }).sizePercent).toBe(138)
  })

  it('falls back instead of writing NaN into a CSS variable', () => {
    // `NaN%` is not a parseable custom-property value: the browser drops the declaration and the
    // cue silently keeps its old size, which is exactly the bug a clamp is supposed to prevent.
    expect(normalizeSubtitleStyle({ ...DEFAULT_SUBTITLE_STYLE, sizePercent: Number.NaN }).sizePercent).toBe(100)
    expect(normalizeSubtitleStyle({ ...DEFAULT_SUBTITLE_STYLE, sizePercent: '150' as unknown as number }).sizePercent).toBe(100)
    expect(normalizeSubtitleStyle(null)).toEqual(DEFAULT_SUBTITLE_STYLE)
    expect(normalizeSubtitleStyle('nonsense')).toEqual(DEFAULT_SUBTITLE_STYLE)
  })

  it('reads an unknown colour as white and a missing outline as on', () => {
    expect(normalizeSubtitleStyle({ ...DEFAULT_SUBTITLE_STYLE, color: 'chartreuse' as never }).color).toBe('white')
    expect(normalizeSubtitleStyle({ sizePercent: 100 }).outline).toBe(true)
  })

  it('turns a style into the four custom properties the stylesheet reads', () => {
    const vars = subtitleStyleVars({ sizePercent: 125, color: 'cyan', backgroundOpacity: 85, outline: true })
    expect(vars['--cue-size']).toBe('125%')
    expect(vars['--cue-color']).toBe('#7fe3ff')
    expect(vars['--cue-bg']).toBe('rgba(0, 0, 0, 0.85)')
    expect(vars['--cue-shadow']).not.toBe('none')
  })

  it('asks for no box at all when the viewer chose None', () => {
    // `rgba(0,0,0,0)` still paints a box in some renderers; `transparent` is the value that skips it.
    expect(subtitleStyleVars({ ...DEFAULT_SUBTITLE_STYLE, backgroundOpacity: 0 })['--cue-bg']).toBe('transparent')
    expect(subtitleStyleVars({ ...DEFAULT_SUBTITLE_STYLE, outline: false })['--cue-shadow']).toBe('none')
  })

  it('writes every property onto the root it is given, and survives having no document', () => {
    const written = new Map<string, string>()
    const root = { style: { setProperty: (name: string, value: string) => void written.set(name, value) } } as unknown as HTMLElement
    applySubtitleStyle({ sizePercent: 150, color: 'yellow', backgroundOpacity: 45, outline: true }, root)
    expect([...written.keys()].sort()).toEqual(['--cue-bg', '--cue-color', '--cue-shadow', '--cue-size'])
    expect(written.get('--cue-size')).toBe('150%')
    expect(() => applySubtitleStyle(DEFAULT_SUBTITLE_STYLE, null)).not.toThrow()
  })
})

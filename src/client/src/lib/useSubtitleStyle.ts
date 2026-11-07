import { useCallback, useEffect, useState } from 'react'
import { loadPlayerPrefs, savePlayerPrefs } from './playerPrefs'
import { applySubtitleStyle, type SubtitleStyle } from './subtitleStyle'

/**
 * The viewer's cue styling: read once, applied to the document, written back on every change.
 *
 * Applied at the document root rather than on the video element because the cue renderer is the
 * browser's, not ours — every `<video>` inside `.player-wrap` picks the variables up from the
 * stylesheet's single `video::cue` rule, including multi-view tiles that are not rendered by the
 * component that owns this state. Writing it from here also means a remount (a channel change, a
 * new film) inherits the choice without a flash of the default style.
 */
export function useSubtitleStyle(): [SubtitleStyle, (next: SubtitleStyle) => void] {
  const [style, setStyle] = useState<SubtitleStyle>(() => loadPlayerPrefs().subtitleStyle)

  useEffect(() => {
    applySubtitleStyle(style)
  }, [style])

  const update = useCallback((next: SubtitleStyle) => {
    setStyle(next)
    // Read-modify-write, like every other preference here: the audio and subtitle track choices
    // live in the same object, and saving a bare `{ subtitleStyle }` would erase them.
    savePlayerPrefs({ ...loadPlayerPrefs(), subtitleStyle: next })
  }, [])

  return [style, update]
}

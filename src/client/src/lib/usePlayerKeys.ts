import { useEffect, type RefObject } from 'react'
import { actionForKey, isTypingTarget, seekTarget, SEEK_STEP_SECONDS } from './playerKeys'

/**
 * Attach the shortcuts to a player's own `<video>`.
 *
 * A hook rather than a listener in each component because the two players differ only in
 * `seekable` and in whether they have a `<video>` at all (the client-side canvas engine does not):
 * everything else — refusing while someone types, clamping a seek, not stealing modified keys —
 * has to behave identically or the feature is a source of surprises.
 */
export function usePlayerKeys({
  seekable,
  videoRef,
  onHelp
}: {
  seekable: boolean
  videoRef: RefObject<HTMLVideoElement | null>
  onHelp: () => void
}): void {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (isTypingTarget(event.target)) return
      const action = actionForKey(event, { seekable })
      if (!action) return
      if (action === 'help') {
        event.preventDefault()
        onHelp()
        return
      }
      const video = videoRef.current
      // The canvas engine has no <video> to drive: it keeps its own clock, and half-applying a
      // shortcut here (audio without picture, say) would be worse than doing nothing.
      if (!video) return
      switch (action) {
        case 'toggle':
          event.preventDefault()
          if (video.paused) void video.play().catch(() => {})
          else video.pause()
          break
        case 'seek-back':
        case 'seek-forward':
          event.preventDefault()
          video.currentTime = seekTarget(
            video.currentTime,
            Number.isFinite(video.duration) ? video.duration : null,
            action === 'seek-forward' ? SEEK_STEP_SECONDS : -SEEK_STEP_SECONDS
          )
          break
        case 'volume-up':
          event.preventDefault()
          video.volume = Math.min(1, Math.round((video.volume + 0.1) * 100) / 100)
          video.muted = false
          break
        case 'volume-down':
          event.preventDefault()
          video.volume = Math.max(0, Math.round((video.volume - 0.1) * 100) / 100)
          break
        case 'mute':
          event.preventDefault()
          video.muted = !video.muted
          break
        case 'fullscreen':
          event.preventDefault()
          if (document.fullscreenElement) void document.exitFullscreen().catch(() => {})
          else void video.requestFullscreen?.().catch(() => {})
          break
        default:
          break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [seekable, videoRef, onHelp])
}

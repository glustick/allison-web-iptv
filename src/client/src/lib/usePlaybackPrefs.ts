import { useCallback, useEffect, useState, type RefObject } from 'react'
import { loadPlayerPrefs, savePlayerPrefs } from './playerPrefs'

/**
 * Volume, mute and playback speed that survive a reload (v0.93.0).
 *
 * Two ordering rules matter more than the feature:
 *
 * 1. **Volume is applied immediately; mute is applied on the first `playing` event.** Setting
 *    `muted = false` before playback starts is exactly what makes a browser refuse an autoplay, and
 *    the app's attach path relies on autoplay working. Waiting for `playing` costs nothing and
 *    cannot break the start.
 * 2. **Nothing is applied to an element that has no source yet.** The hook runs against whatever
 *    `<video>` the player currently owns; after a channel change that is a fresh element, and the
 *    effect re-runs on the ref's owner because the players call it with a stable ref.
 */
export function usePlaybackPrefs(
  videoRef: RefObject<HTMLVideoElement | null>,
  options: { allowRate: boolean }
): { rate: number; setRate: (rate: number) => void } {
  const [rate, setRateState] = useState<number>(() => loadPlayerPrefs().playbackRate)

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    const saved = loadPlayerPrefs()
    if (typeof saved.volume === 'number') video.volume = saved.volume
    if (options.allowRate) video.playbackRate = saved.playbackRate

    const applyOnPlay = (): void => {
      const latest = loadPlayerPrefs()
      video.muted = latest.muted
      if (typeof latest.volume === 'number') video.volume = latest.volume
      if (options.allowRate) video.playbackRate = latest.playbackRate
    }
    const persist = (): void => {
      savePlayerPrefs({ ...loadPlayerPrefs(), volume: video.volume, muted: video.muted })
    }
    video.addEventListener('playing', applyOnPlay)
    video.addEventListener('volumechange', persist)
    return () => {
      video.removeEventListener('playing', applyOnPlay)
      video.removeEventListener('volumechange', persist)
    }
  }, [videoRef, options.allowRate])

  const setRate = useCallback(
    (next: number) => {
      const video = videoRef.current
      if (video) video.playbackRate = next
      setRateState(next)
      savePlayerPrefs({ ...loadPlayerPrefs(), playbackRate: next })
    },
    [videoRef]
  )

  return { rate, setRate }
}

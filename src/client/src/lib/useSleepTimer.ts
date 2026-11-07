import { useCallback, useEffect, useRef, useState } from 'react'
import {
  clearSleepTimer,
  readSleepTimer,
  remainingSeconds,
  saveSleepTimer,
  startSleepTimer,
  startUntil,
  type SleepTimer
} from './sleepTimer'

/**
 * A sleep timer's live state: the stored deadline, its countdown, and the moment it fires.
 *
 * The tick exists only to update the display and to notice expiry; the deadline itself is the
 * stored `endsAt`, so a throttled or suspended tab is late by at most one interval and never
 * drifts. `onExpire` is held in a ref: a caller re-rendering must not restart the interval, and a
 * stale closure must not be the thing that decides playback has ended.
 */
export function useSleepTimer(onExpire: () => void): {
  timer: SleepTimer | null
  remaining: number
  start: (minutes: number) => void
  /** Arm the timer to finish at a given moment — the guide's "end of this programme". */
  startAt: (endsAt: number, label?: string) => void
  cancel: () => void
} {
  const [timer, setTimer] = useState<SleepTimer | null>(() => readSleepTimer())
  const [remaining, setRemaining] = useState<number>(() => {
    const current = readSleepTimer()
    return current ? remainingSeconds(current) : 0
  })
  const expireRef = useRef(onExpire)

  useEffect(() => {
    expireRef.current = onExpire
  })

  useEffect(() => {
    if (!timer) return
    const tick = (): void => {
      const left = remainingSeconds(timer)
      setRemaining(left)
      if (left === 0) {
        // Cleared before the callback so a failing `onExpire` cannot leave a timer that fires
        // every second from here on.
        clearSleepTimer()
        setTimer(null)
        expireRef.current()
      }
    }
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [timer])

  const start = useCallback((minutes: number) => {
    const next = startSleepTimer(minutes)
    if (!next) return
    saveSleepTimer(next)
    setTimer(next)
    setRemaining(remainingSeconds(next))
  }, [])

  const startAt = useCallback((endsAt: number, label?: string) => {
    const next = startUntil(endsAt, Date.now(), label)
    if (!next) return
    saveSleepTimer(next)
    setTimer(next)
    setRemaining(remainingSeconds(next))
  }, [])

  const cancel = useCallback(() => {
    clearSleepTimer()
    setTimer(null)
    setRemaining(0)
  }, [])

  return { timer, remaining, start, startAt, cancel }
}

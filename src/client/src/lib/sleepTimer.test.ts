import { describe, expect, it } from 'vitest'
import {
  clearSleepTimer,
  endOfPlaybackDeadline,
  formatCountdown,
  readSleepTimer,
  remainingSeconds,
  saveSleepTimer,
  startSleepTimer
} from './sleepTimer'

function fakeStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial))
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    has: (k: string) => map.has(k)
  }
}

const NOW = 1_700_000_000_000

describe('sleep timer', () => {
  it('is a deadline, so it survives a suspension instead of drifting', () => {
    const timer = startSleepTimer(30, NOW)
    expect(timer).toEqual({ minutes: 30, endsAt: NOW + 30 * 60_000 })
    expect(remainingSeconds(timer!, NOW + 10 * 60_000)).toBe(20 * 60)
  })

  it('rounds up, so the last second reads 0:01 rather than 0:00', () => {
    const timer = startSleepTimer(15, NOW)!
    expect(remainingSeconds(timer, timer.endsAt - 200)).toBe(1)
    expect(remainingSeconds(timer, timer.endsAt)).toBe(0)
    expect(remainingSeconds(timer, timer.endsAt + 5_000)).toBe(0)
  })

  it('refuses a duration that is not a sane positive number', () => {
    expect(startSleepTimer(0, NOW)).toBeNull()
    expect(startSleepTimer(-15, NOW)).toBeNull()
    expect(startSleepTimer(Number.NaN, NOW)).toBeNull()
    expect(startSleepTimer(13 * 60, NOW)).toBeNull()
  })

  it('formats a countdown as a clock', () => {
    expect(formatCountdown(59)).toBe('00:59')
    expect(formatCountdown(9 * 60 + 59)).toBe('09:59')
    expect(formatCountdown(90 * 60)).toBe('1:30:00')
    expect(formatCountdown(-4)).toBe('00:00')
  })

  it('round-trips through storage', () => {
    const storage = fakeStorage()
    const timer = startSleepTimer(45, NOW)!
    saveSleepTimer(timer, storage)
    expect(readSleepTimer(NOW, storage)).toEqual(timer)
    clearSleepTimer(storage)
    expect(readSleepTimer(NOW, storage)).toBeNull()
  })

  it('clears a deadline that already passed rather than firing on the next visit', () => {
    // The failure this prevents: a timer armed before bed firing when the tab is reopened the next
    // evening, ending a film someone deliberately started.
    const storage = fakeStorage({ 'iptv:sleep-timer': JSON.stringify({ minutes: 30, endsAt: NOW - 1_000 }) })
    expect(readSleepTimer(NOW, storage)).toBeNull()
    expect(storage.has('iptv:sleep-timer')).toBe(false)
  })

  it('rejects rubbish and absurd deadlines, and survives a store that throws', () => {
    expect(readSleepTimer(NOW, fakeStorage({ 'iptv:sleep-timer': 'not json' }))).toBeNull()
    expect(readSleepTimer(NOW, fakeStorage({ 'iptv:sleep-timer': JSON.stringify({ minutes: 30 }) }))).toBeNull()
    expect(
      readSleepTimer(NOW, fakeStorage({ 'iptv:sleep-timer': JSON.stringify({ minutes: 30, endsAt: NOW + 20 * 60 * 60_000 }) }))
    ).toBeNull()
    const hostile = { getItem: () => { throw new Error('nope') }, removeItem: () => {} }
    expect(readSleepTimer(NOW, hostile)).toBeNull()
  })
})

describe('the end of what is playing', () => {
  const NOW = 1_700_000_000_000

  it('is the remaining time at normal speed', () => {
    expect(endOfPlaybackDeadline(600, 1800, NOW, 1)).toBe(NOW + 1200 * 1000)
  })

  it('shrinks at faster speeds', () => {
    expect(endOfPlaybackDeadline(600, 1800, NOW, 1.5)).toBe(NOW + 800 * 1000)
  })

  it('has no deadline without a duration, and none once it is over', () => {
    expect(endOfPlaybackDeadline(600, null, NOW, 1)).toBeNull()
    expect(endOfPlaybackDeadline(1800, 1800, NOW, 1)).toBe(NOW)
  })
})

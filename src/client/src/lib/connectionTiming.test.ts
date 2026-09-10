import { describe, expect, it } from 'vitest'
import { formatElapsedTime } from './connectionTiming'

describe('formatElapsedTime', () => {
  it('formats zero as a clean mm:ss clock', () => {
    expect(formatElapsedTime(0)).toBe('00:00')
  })

  it('formats a sub-minute duration using the elapsed milliseconds', () => {
    expect(formatElapsedTime(59_000)).toBe('00:59')
  })

  it('formats durations over a minute with the full mm:ss clock', () => {
    expect(formatElapsedTime(61_000)).toBe('01:01')
  })

  it('keeps growing values readable at longer durations', () => {
    expect(formatElapsedTime(3_661_000)).toBe('61:01')
  })
})

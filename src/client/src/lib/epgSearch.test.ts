import { describe, expect, it } from 'vitest'
import { channelForResult, describeResultTime, jumpOffsetFor } from './epgSearch.js'

const NOW = new Date('2026-11-14T20:00:00').getTime()

describe('jumpOffsetFor', () => {
  it('places the programme half an hour before the window’s left edge', () => {
    const start = NOW + 3 * 60 * 60 * 1000
    expect(jumpOffsetFor(start, NOW)).toBe(3 * 60 * 60 * 1000 - 30 * 60 * 1000)
  })

  it('an in-progress programme pulls the window back so its block is visible', () => {
    const started = NOW - 20 * 60 * 1000
    expect(jumpOffsetFor(started, NOW)).toBe(-50 * 60 * 1000)
  })
})

describe('describeResultTime', () => {
  it('reads as a range without a weekday when the programme is today', () => {
    const text = describeResultTime(NOW, NOW + 60 * 60 * 1000, NOW)
    expect(text).toMatch(/ – /)
    expect(text).not.toContain('·')
  })

  it('names the weekday when the programme is not today', () => {
    const text = describeResultTime(NOW + 26 * 60 * 60 * 1000, NOW + 27 * 60 * 60 * 1000, NOW)
    expect(text).toContain('·')
  })
})

describe('channelForResult', () => {
  const channels = [
    { stream_id: 668, name: 'A' },
    { stream_id: 668, name: 'B', playlistId: 'p2' }
  ] as never as Array<{ stream_id: number; name: string; playlistId?: string }>

  it('resolves bare keys to the primary channel and composite keys to the scoped one', () => {
    expect(channelForResult(channels as never, ':668')?.name).toBe('A')
    expect(channelForResult(channels as never, 'p2:668')?.name).toBe('B')
  })

  it('answers null for a key with no row on screen', () => {
    expect(channelForResult(channels as never, 'zz:1')).toBeNull()
  })
})

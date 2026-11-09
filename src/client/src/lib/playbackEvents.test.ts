import { describe, expect, it } from 'vitest'
import { appendEvent, PLAYBACK_EVENT_LIMIT } from './playbackEvents'

describe('the player event log', () => {
  it('keeps the newest first', () => {
    const first = appendEvent([], 'attached', '10:00:01')
    const second = appendEvent(first, 'stalled', '10:00:02')
    expect(second.map((event) => event.message)).toEqual(['stalled', 'attached'])
  })

  it('is bounded, dropping the oldest', () => {
    let events = appendEvent([], 'oldest', '10:00:00', 3)
    events = appendEvent(events, 'middle', '10:00:01', 3)
    events = appendEvent(events, 'newer', '10:00:02', 3)
    events = appendEvent(events, 'newest', '10:00:03', 3)
    expect(events.map((event) => event.message)).toEqual(['newest', 'newer', 'middle'])
  })

  it('never mutates the list it was given', () => {
    const before = appendEvent([], 'one', '10:00:00')
    const after = appendEvent(before, 'two', '10:00:01')
    expect(before).toHaveLength(1)
    expect(after).toHaveLength(2)
  })

  it('is empty when the limit is zero rather than keeping one', () => {
    expect(appendEvent([], 'anything', '10:00:00', 0)).toEqual([])
  })

  it('has a limit a person can read on a phone', () => {
    expect(PLAYBACK_EVENT_LIMIT).toBeLessThanOrEqual(30)
  })
})

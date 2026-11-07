import { describe, expect, it } from 'vitest'
import { clockLabel, pickNowNext, programmeProgress } from './guideNowNext'

const at = (h: number, m = 0): number => new Date(2026, 10, 7, h, m, 0, 0).getTime()

const schedule = [
  { startMs: at(20), stopMs: at(21), title: 'News' },
  { startMs: at(21), stopMs: at(22, 30), title: 'Match' },
  { startMs: at(22, 30), stopMs: at(23), title: 'Highlights' }
]

describe('now and next', () => {
  it('finds the programme on air and the one after it', () => {
    const { current, next } = pickNowNext(schedule, at(21, 15))
    expect(current?.title).toBe('Match')
    expect(next?.title).toBe('Highlights')
  })

  it('treats the start boundary as on air and the end boundary as over', () => {
    expect(pickNowNext(schedule, at(21)).current?.title).toBe('Match')
    // 21:00:00 exactly is the end of News and the start of Match — the later programme wins.
    expect(pickNowNext(schedule, at(22, 30)).current?.title).toBe('Highlights')
    expect(pickNowNext(schedule, at(23)).current).toBeNull()
  })

  it('reports a gap honestly rather than inventing a programme', () => {
    const gapped = [
      { startMs: at(20), stopMs: at(21), title: 'News' },
      { startMs: at(22), stopMs: at(23), title: 'Film' }
    ]
    const { current, next } = pickNowNext(gapped, at(21, 30))
    expect(current).toBeNull()
    expect(next?.title).toBe('Film')
  })

  it('has nothing to say about a channel with no guide', () => {
    expect(pickNowNext(undefined, at(21))).toEqual({ current: null, next: null })
    expect(pickNowNext([], at(21))).toEqual({ current: null, next: null })
  })

  it('sorts a guide that arrives out of order', () => {
    const shuffled = [schedule[2], schedule[0], schedule[1]]
    expect(pickNowNext(shuffled, at(20, 30)).current?.title).toBe('News')
  })

  it('measures progress through the programme, clamped', () => {
    const match = schedule[1]
    expect(programmeProgress(match, at(21))).toBe(0)
    expect(programmeProgress(match, at(21, 45))).toBeCloseTo(0.5)
    expect(programmeProgress(match, at(23))).toBe(1)
    expect(programmeProgress(match, at(19))).toBe(0)
    // A zero-length programme cannot be divided by; it reads as not started.
    expect(programmeProgress({ startMs: at(21), stopMs: at(21), title: 'x' }, at(21))).toBe(0)
  })

  it('prints a clock label the way the guide does', () => {
    expect(clockLabel(at(9, 5))).toBe('09:05')
    expect(clockLabel(at(21, 30))).toBe('21:30')
  })
})

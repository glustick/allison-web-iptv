import { describe, expect, it } from 'vitest'
import { continueWatching, formatDuration, isFinished, progressPercent } from './continueWatching'

describe('when a title is finished', () => {
  it('calls a film finished once it is 95% through', () => {
    expect(isFinished(0.95 * 7200, 7200)).toBe(true)
    expect(isFinished(0.9 * 7200, 7200)).toBe(false)
  })

  it('lets the credits run: two minutes left of a feature counts', () => {
    expect(isFinished(7200 - 100, 7200)).toBe(true)
  })

  it('does not apply the credits rule to a short clip', () => {
    // The failure this prevents: "two minutes left" on a five-minute item would mark it finished
    // before it had started.
    expect(isFinished(0, 300)).toBe(false)
    expect(isFinished(120, 300)).toBe(false)
    // At 95% of the same clip it is genuinely finished.
    expect(isFinished(285, 300)).toBe(true)
  })

  it('treats a position past the end as finished, and an unknown duration as never finished', () => {
    expect(isFinished(7300, 7200)).toBe(true)
    expect(isFinished(600, null)).toBe(false)
    expect(isFinished(600, 0)).toBe(false)
  })
})

describe('the continue-watching list', () => {
  const entry = (name: string, position: number, updatedAt: string) => ({
    name,
    positionSeconds: position,
    durationSeconds: 7200,
    updatedAt
  })

  it('drops finished titles — the whole point', () => {
    const list = continueWatching([entry('finished', 7100, '2026-11-01T10:00:00Z'), entry('half', 3600, '2026-11-01T09:00:00Z')])
    expect(list.map((e) => e.name)).toEqual(['half'])
  })

  it('puts the most recently watched first', () => {
    const list = continueWatching([
      entry('older', 100, '2026-10-30T10:00:00Z'),
      entry('newer', 100, '2026-11-06T10:00:00Z'),
      entry('middle', 100, '2026-11-02T10:00:00Z')
    ])
    expect(list.map((e) => e.name)).toEqual(['newer', 'middle', 'older'])
  })

  it('sorts an unreadable date last rather than first', () => {
    const list = continueWatching([entry('undated', 100, ''), entry('dated', 100, '2026-11-06T10:00:00Z')])
    expect(list.map((e) => e.name)).toEqual(['dated', 'undated'])
  })

  it('caps the shelf', () => {
    const many = Array.from({ length: 12 }, (_, i) => entry(`f${i}`, 100, `2026-11-0${(i % 9) + 1}T10:00:00Z`))
    expect(continueWatching(many, 5)).toHaveLength(5)
  })
})

describe('progress percentage', () => {
  it('reports a whole percentage, clamped', () => {
    expect(progressPercent(3600, 7200)).toBe(50)
    expect(progressPercent(9000, 7200)).toBe(100)
    expect(progressPercent(-5, 7200)).toBe(0)
  })

  it('reports nothing when the duration is unknown', () => {
    expect(progressPercent(600, null)).toBeNull()
    expect(progressPercent(600, 0)).toBeNull()
  })
})

describe('formatting a position', () => {
  it('reads as a clock', () => {
    expect(formatDuration(59)).toBe('00:59')
    expect(formatDuration(754)).toBe('12:34')
    expect(formatDuration(3723)).toBe('1:02:03')
    expect(formatDuration(-4)).toBe('00:00')
  })
})

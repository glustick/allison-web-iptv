import { describe, expect, it } from 'vitest'
import { catchupForProgramme } from './catchup'

const now = Date.UTC(2026, 8, 16, 12, 0) / 1000 * 1000
const hour = 3_600_000

describe('catchupForProgramme', () => {
  it('offers a finished programme inside the archive window', () => {
    const result = catchupForProgramme(
      { tv_archive: 1, tv_archive_duration: 7 },
      { startMs: now - 3 * hour, stopMs: now - 2 * hour },
      now
    )
    expect(result).not.toBeNull()
    expect(result?.durationMinutes).toBe(60)
  })

  it('offers nothing for a channel without catch-up', () => {
    expect(
      catchupForProgramme({ tv_archive: 0, tv_archive_duration: 7 }, { startMs: now - hour, stopMs: now - 1 }, now)
    ).toBeNull()
    expect(catchupForProgramme({}, { startMs: now - hour, stopMs: now - 1 }, now)).toBeNull()
  })

  it('leaves a programme that is still on to the live stream', () => {
    const result = catchupForProgramme(
      { tv_archive: 1, tv_archive_duration: 7 },
      { startMs: now - hour, stopMs: now + hour },
      now
    )
    expect(result).toBeNull()
  })

  it('offers nothing beyond the archive window', () => {
    // 7 days of archive, and this programme started 8 days ago.
    expect(
      catchupForProgramme(
        { tv_archive: 1, tv_archive_duration: 7 },
        { startMs: now - 8 * 24 * hour, stopMs: now - 8 * 24 * hour + hour },
        now
      )
    ).toBeNull()
  })

  it('treats a missing or nonsensical archive duration as no catch-up', () => {
    for (const duration of [undefined, 0, -3, Number.NaN]) {
      expect(
        catchupForProgramme(
          { tv_archive: 1, tv_archive_duration: duration as number | undefined },
          { startMs: now - hour, stopMs: now - 60_000 },
          now
        ),
        String(duration)
      ).toBeNull()
    }
  })

  it('never asks for less than a minute, and rounds a partial minute up', () => {
    const short = catchupForProgramme(
      { tv_archive: 1, tv_archive_duration: 1 },
      { startMs: now - 30_000, stopMs: now - 10_000 },
      now
    )
    expect(short?.durationMinutes).toBe(1)
  })
})

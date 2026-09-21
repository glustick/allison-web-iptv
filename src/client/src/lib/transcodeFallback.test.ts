import { describe, expect, it } from 'vitest'
import { resolveTrackSelection, stallRecoveryShape, STALL_RELOADS_BEFORE_CONVERTING } from './transcodeFallback'

describe('resolveTrackSelection', () => {
  it('keeps valid explicit selections when they exist', () => {
    const result = resolveTrackSelection(
      { audioIndex: 1, subtitleIndex: 1 },
      [{ index: 0 }, { index: 1 }],
      [{ index: 0 }, { index: 1 }]
    )

    expect(result).toEqual({ audioIndex: 1, subtitleIndex: 1 })
  })

  it('falls back to the first available track when a requested index is invalid', () => {
    const result = resolveTrackSelection(
      { audioIndex: 99, subtitleIndex: -1 },
      [{ index: 0 }],
      [{ index: 0 }]
    )

    expect(result).toEqual({ audioIndex: 0, subtitleIndex: 0 })
  })
})

describe('stallRecoveryShape', () => {
  const onSession = { onTranscodeSession: true, videoTranscodeTried: false, reloadAttempts: 0 }
  const direct = { onTranscodeSession: false, videoTranscodeTried: false, reloadAttempts: 0 }

  it('rebuilds a direct stream while it still has reloads left', () => {
    expect(stallRecoveryShape(direct)).toBe('reload')
    expect(stallRecoveryShape({ ...direct, reloadAttempts: STALL_RELOADS_BEFORE_CONVERTING - 1 })).toBe('reload')
  })

  it('converts a direct stream once its reloads are spent, instead of giving up', () => {
    // v0.46.2: the one rung where a channel could die without the transcoder ever being offered.
    expect(stallRecoveryShape({ ...direct, reloadAttempts: STALL_RELOADS_BEFORE_CONVERTING })).toBe('convert')
  })

  it('gives up on a direct stream only after the video tier has been tried too', () => {
    expect(stallRecoveryShape({ ...direct, reloadAttempts: 5, videoTranscodeTried: true })).toBe('give-up')
  })

  it('replaces a stalled session in place — a stall never costs picture quality', () => {
    // v0.46.1 escalated a stalled stream-copying session to the re-encode tier, which downscaled the
    // channel to work around a stalling relay. That is the viewer's picture; it is not this ladder's
    // call to make, and it is not the behaviour this app should have.
    expect(stallRecoveryShape(onSession)).toBe('session')
    expect(stallRecoveryShape({ ...onSession, reloadAttempts: 9 })).toBe('session')
    expect(stallRecoveryShape({ ...onSession, videoTranscodeTried: true })).toBe('session')
  })
})

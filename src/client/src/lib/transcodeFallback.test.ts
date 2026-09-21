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
  const onSession = { onTranscodeSession: true, videoTranscode: false, videoTranscodeTried: false, reloadAttempts: 0 }
  const direct = { onTranscodeSession: false, videoTranscode: false, videoTranscodeTried: false, reloadAttempts: 0 }

  it('rebuilds a direct stream while it still has reloads left', () => {
    expect(stallRecoveryShape(direct)).toBe('reload')
    expect(stallRecoveryShape({ ...direct, reloadAttempts: STALL_RELOADS_BEFORE_CONVERTING - 1 })).toBe('reload')
  })

  it('converts a direct stream once its reloads are spent, instead of giving up', () => {
    // v0.46.2: the one rung where a channel could die without the transcoder ever being offered.
    expect(stallRecoveryShape({ ...direct, reloadAttempts: STALL_RELOADS_BEFORE_CONVERTING })).toBe('convert')
  })

  it('gives up on a direct stream only after the transcoder has been tried too', () => {
    expect(stallRecoveryShape({ ...direct, reloadAttempts: 5, videoTranscodeTried: true })).toBe('give-up')
  })

  it('escalates a stalled stream-copy session to the video re-encode tier', () => {
    // The measured "UHD channels don't play well" shape: replacing a starving 4K copy session with
    // another 4K copy session repeats the failure instead of reaching the tier that fixes it.
    expect(stallRecoveryShape(onSession)).toBe('video-transcode')
  })

  it('replaces the session in place once the video tier has already been tried', () => {
    expect(stallRecoveryShape({ ...onSession, videoTranscodeTried: true })).toBe('session')
  })

  it('never escalates away from a session that is already re-encoding', () => {
    expect(stallRecoveryShape({ ...onSession, videoTranscode: true })).toBe('session')
  })

  it('keeps a run on the session rules however many reloads it has spent', () => {
    expect(stallRecoveryShape({ ...onSession, reloadAttempts: 9 })).toBe('video-transcode')
    expect(stallRecoveryShape({ ...onSession, reloadAttempts: 9, videoTranscodeTried: true })).toBe('session')
  })
})

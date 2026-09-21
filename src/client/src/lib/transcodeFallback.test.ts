import { describe, expect, it } from 'vitest'
import { resolveTrackSelection, stallRecoveryShape } from './transcodeFallback'

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
  const state = { onTranscodeSession: true, videoTranscode: false, videoTranscodeTried: false }

  it('rebuilds the source when the run is not on a transcode session at all', () => {
    expect(stallRecoveryShape({ ...state, onTranscodeSession: false })).toBe('source')
  })

  it('escalates a stalled stream-copy session to the video re-encode tier', () => {
    // The measured "UHD channels don't play well" shape: replacing a starving 4K copy session with
    // another 4K copy session repeats the failure instead of reaching the tier that fixes it.
    expect(stallRecoveryShape(state)).toBe('video-transcode')
  })

  it('replaces the session in place once the video tier has already been tried', () => {
    expect(stallRecoveryShape({ ...state, videoTranscodeTried: true })).toBe('session')
  })

  it('never escalates away from a session that is already re-encoding', () => {
    expect(stallRecoveryShape({ ...state, videoTranscode: true })).toBe('session')
  })
})

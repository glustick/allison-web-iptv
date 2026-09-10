import { describe, expect, it } from 'vitest'
import { resolveTrackSelection } from './transcodeFallback'

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

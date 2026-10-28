import { describe, expect, it } from 'vitest'
import { validatePasswordChange } from './passwordChange'

describe('validatePasswordChange', () => {
  it('accepts a well-formed change', () => {
    expect(validatePasswordChange('old-one', 'new-one', 'new-one')).toBeNull()
  })

  it('names the earliest problem first, in fill order', () => {
    expect(validatePasswordChange('', '', '')).toBe('Enter your current password.')
    expect(validatePasswordChange('old', 'short', 'short')).toBe('The new password must be at least 6 characters.')
    expect(validatePasswordChange('same-one', 'same-one', 'same-one')).toBe(
      'The new password must be different from the current one.'
    )
    expect(validatePasswordChange('old-one', 'new-one', 'different')).toBe('The two new-password fields do not match.')
  })
})

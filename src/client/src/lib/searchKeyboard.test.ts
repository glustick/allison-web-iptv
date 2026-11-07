import { describe, expect, it } from 'vitest'
import { nextHighlight } from './searchKeyboard'

describe('moving through search results', () => {
  it('starts at the top going down, at the bottom going up', () => {
    expect(nextHighlight(-1, 1, 3)).toBe(0)
    expect(nextHighlight(-1, -1, 3)).toBe(2)
  })

  it('clamps instead of wrapping', () => {
    expect(nextHighlight(2, 1, 3)).toBe(2)
    expect(nextHighlight(0, -1, 3)).toBe(0)
  })

  it('steps normally in the middle', () => {
    expect(nextHighlight(1, 1, 3)).toBe(2)
    expect(nextHighlight(1, -1, 3)).toBe(1 - 1)
  })

  it('has nowhere to go in an empty list', () => {
    expect(nextHighlight(-1, 1, 0)).toBe(-1)
  })
})

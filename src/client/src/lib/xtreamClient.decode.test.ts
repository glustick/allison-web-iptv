import { describe, expect, it } from 'vitest'
import { decodeBase64Maybe } from './xtreamClient'

const b64 = (text: string): string => Buffer.from(text, 'utf8').toString('base64')

describe('decoding a short-EPG title', () => {
  it('leaves plain text alone, even when atob would accept it', () => {
    // The bug a fixture found: atob strips spaces, so "World at Noon" looked decodable and turned
    // into mojibake. These are the exact strings that did it.
    expect(decodeBase64Maybe('World at Noon')).toBe('World at Noon')
    expect(decodeBase64Maybe('The Long Read')).toBe('The Long Read')
    expect(decodeBase64Maybe('Morning Briefing')).toBe('Morning Briefing')
    expect(decodeBase64Maybe('Evening Bulletin')).toBe('Evening Bulletin')
  })

  it('decodes a genuinely encoded title', () => {
    expect(decodeBase64Maybe(b64('Matchday Build-up'))).toBe('Matchday Build-up')
    expect(decodeBase64Maybe(b64('Cuenta atrás'))).toBe('Cuenta atrás')
  })

  it('returns the input when the decode would not be text', () => {
    // Base64-shaped, but the bytes are not valid UTF-8: keep what the provider sent.
    expect(decodeBase64Maybe('AAAAAAAA')).toBe('AAAAAAAA')
    // Control characters are not a title either.
    expect(decodeBase64Maybe(b64('\u0000\u0001'))).toBe(b64('\u0000\u0001'))
  })

  it('handles the empty and absent cases', () => {
    expect(decodeBase64Maybe('')).toBe('')
    expect(decodeBase64Maybe(null)).toBe('')
    expect(decodeBase64Maybe(undefined)).toBe('')
  })
})

process.env.SESSION_SECRET = process.env.SESSION_SECRET ?? 'test-session-secret-1234'

import { describe, expect, it } from 'vitest'
import { decryptSessionCredentials, encryptSessionCredentials, type SessionCredentials } from './sessionStore.js'

describe('encryptSessionCredentials', () => {
  it('round-trips a session credential payload without leaking the raw plaintext', () => {
    const creds: SessionCredentials = {
      server: 'https://example.com:8080',
      username: 'demo-user',
      password: 'demo-pass'
    }

    const encoded = encryptSessionCredentials(creds)
    expect(encoded).toContain('payload')
    expect(encoded).not.toContain('demo-pass')
    expect(decryptSessionCredentials(encoded)).toEqual(creds)
  })

  it('preserves the extra EPG guide URLs', () => {
    const creds: SessionCredentials = {
      server: 'https://example.com:8080',
      username: 'demo-user',
      password: 'demo-pass',
      epgUrls: ['https://guide.example.com/epg.xml', 'https://other.example.com/epg.xml']
    }

    expect(decryptSessionCredentials(encryptSessionCredentials(creds))).toEqual(creds)
  })

  it('refuses an invalid payload instead of returning junk', () => {
    expect(() => decryptSessionCredentials('not-valid-json')).toThrow()
  })

  it('refuses a payload missing required fields', () => {
    expect(() => decryptSessionCredentials(JSON.stringify({ version: 1, payload: 'AAAA' }))).toThrow()
  })
})

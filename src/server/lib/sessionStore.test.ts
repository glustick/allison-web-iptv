process.env.SESSION_SECRET = process.env.SESSION_SECRET ?? 'test-session-secret-1234'

import { describe, expect, it } from 'vitest'
import {
  decryptSessionCredentials,
  decryptSessionProfileState,
  encryptSessionCredentials,
  encryptSessionProfileState,
  type SessionCredentials
} from './sessionStore.js'

describe('encryptSessionCredentials', () => {
  it('round-trips a session credential payload without leaking the raw plaintext', () => {
    const creds: SessionCredentials = {
      accessPassword: 'shared-secret',
      server: 'https://example.com:8080',
      username: 'demo-user',
      password: 'demo-pass'
    }

    const encoded = encryptSessionCredentials(creds)
    expect(encoded).toContain('payload')
    expect(encoded).not.toContain('demo-pass')
    expect(decryptSessionCredentials(encoded)).toEqual(creds)
  })

  it('round-trips a set of saved profiles while preserving the active selection', () => {
    const profiles = {
      activeProfileId: 'family-main',
      profiles: [
        {
          id: 'family-main',
          name: 'Family main',
          credentials: {
            accessPassword: 'shared-secret',
            server: 'https://example.com:8080',
            username: 'demo-user',
            password: 'demo-pass'
          }
        },
        {
          id: 'guest',
          name: 'Guest',
          credentials: {
            accessPassword: 'guest-secret',
            server: 'https://other.example.com:8080',
            username: 'guest-user',
            password: 'guest-pass'
          }
        }
      ]
    }

    const encoded = encryptSessionProfileState(profiles)
    expect(encoded).toContain('payload')
    expect(encoded).not.toContain('guest-pass')
    expect(decryptSessionProfileState(encoded)).toEqual(profiles)
  })

  it('refuses an invalid payload instead of returning junk', () => {
    expect(() => decryptSessionCredentials('not-valid-json')).toThrow()
  })
})

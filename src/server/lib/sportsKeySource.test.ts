import { describe, it, expect } from 'vitest'
import { readSuppliedSportsKey } from './sportsKeySource.js'

// The out-of-band key path: an environment variable, or a file in the app's persisted volume. Kept
// testable because the failure mode it guards against is silent — a key that never arrives looks
// exactly like a key that was never configured.

describe('readSuppliedSportsKey', () => {
  it('prefers the environment variable', () => {
    const supplied = readSuppliedSportsKey({
      dataDir: '/appdata',
      env: { SPORTS_API_KEY: 'from-env' },
      readFile: () => 'from-file'
    })
    expect(supplied).toEqual({ key: 'from-env', source: 'SPORTS_API_KEY' })
  })

  it('falls back to <dataDir>/api-football.txt', () => {
    const supplied = readSuppliedSportsKey({
      dataDir: '/appdata',
      env: {},
      readFile: (path) => (path === '/appdata/api-football.txt' ? ' from-file \n' : null)
    })
    expect(supplied).toEqual({ key: 'from-file', source: '/appdata/api-football.txt' })
  })

  it('honours SPORTS_API_KEY_FILE when set', () => {
    const supplied = readSuppliedSportsKey({
      dataDir: '/appdata',
      env: { SPORTS_API_KEY_FILE: '/run/secrets/sports' },
      readFile: (path) => (path === '/run/secrets/sports' ? 'secret-value' : null)
    })
    expect(supplied?.source).toBe('/run/secrets/sports')
    expect(supplied?.key).toBe('secret-value')
  })

  it('reports nothing when there is nothing, or only whitespace', () => {
    expect(readSuppliedSportsKey({ dataDir: '/appdata', env: {}, readFile: () => null })).toBeNull()
    expect(readSuppliedSportsKey({ dataDir: '/appdata', env: {}, readFile: () => '   \n' })).toBeNull()
    expect(readSuppliedSportsKey({ dataDir: '/appdata', env: { SPORTS_API_KEY: '  ' }, readFile: () => null })).toBeNull()
  })

  it('survives an unreadable file rather than failing startup', () => {
    const supplied = readSuppliedSportsKey({
      dataDir: '/appdata',
      env: {},
      readFile: () => {
        throw new Error('EACCES')
      }
    })
    expect(supplied).toBeNull()
  })
})

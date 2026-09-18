import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createAuthSessionStore, hashAuthToken } from './authSessionStore.js'

// the token is stored encrypted, so the cipher needs a secret (the same one the app uses)
process.env.SESSION_SECRET = process.env.SESSION_SECRET ?? 'test-session-secret-1234'

const dirs: string[] = []
function dataDir() {
  const dir = mkdtempSync(join(tmpdir(), 'session-store-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true })
})

const TTL = 24 * 60 * 60 * 1000
const session = { username: 'chris', role: 'admin', loginAt: 1_000, lastSeenAt: 2_000 }

describe('createAuthSessionStore', () => {
  it('survives a restart — which is the whole point', () => {
    const dir = dataDir()
    const first = createAuthSessionStore({ dataDir: dir, ttlMs: TTL })
    first.save('token-abc', session)
    first.close()

    // a new store on the same directory is exactly what a container recreate looks like
    const second = createAuthSessionStore({ dataDir: dir, ttlMs: TTL })
    const loaded = second.load(3_000)
    expect(loaded).toHaveLength(1)
    // the raw token comes back (decrypted), so the in-memory map rebuilds exactly as it was
    expect(loaded[0].token).toBe('token-abc')
    expect(loaded[0].tokenHash).toBe(hashAuthToken('token-abc'))
    expect(loaded[0].session.username).toBe('chris')
    expect(loaded[0].session.role).toBe('admin')
    second.close()
  })

  it('never writes the raw token', () => {
    const dir = dataDir()
    const store = createAuthSessionStore({ dataDir: dir, ttlMs: TTL })
    store.save('super-secret-token', session)
    const raw = require('node:fs').readFileSync(join(dir, 'allison.db'))
    expect(raw.includes(Buffer.from('super-secret-token'))).toBe(false)
    store.close()
  })

  it('drops idle-expired sessions on load, and prunes them', () => {
    const dir = dataDir()
    const store = createAuthSessionStore({ dataDir: dir, ttlMs: TTL })
    const now = 10_000_000
    store.save('old', { ...session, lastSeenAt: now - TTL - 1 })   // just past the idle window
    store.save('fresh', { ...session, lastSeenAt: now - 1_000 })
    expect(store.load(now).map((r) => r.session.lastSeenAt)).toEqual([now - 1_000])
    expect(store.prune(now)).toBe(1)
    expect(store.load(now)).toHaveLength(1)
    store.close()
  })

  it('writes a touched session at most once per interval', () => {
    const dir = dataDir()
    const store = createAuthSessionStore({ dataDir: dir, ttlMs: TTL })
    store.save('t', { ...session, lastSeenAt: 2_000 })
    store.touch('t', 2_500, 60_000)          // inside the interval: no write
    expect(store.load(3_000)[0].session.lastSeenAt).toBe(2_000)
    store.touch('t', 100_000, 60_000)        // well past it: written
    expect(store.load(100_500)[0].session.lastSeenAt).toBe(100_000)
    store.close()
  })

  it('removes one session, or every session a user has', () => {
    const dir = dataDir()
    const store = createAuthSessionStore({ dataDir: dir, ttlMs: TTL })
    store.save('a', session)
    store.save('b', session)
    store.save('c', { ...session, username: 'autoclaw' })
    store.remove('a')
    expect(store.load(3_000)).toHaveLength(2)
    store.removeForUser('chris')
    expect(store.load(3_000).map((r) => r.session.username)).toEqual(['autoclaw'])
    store.close()
  })

  it('signing in again replaces the row for the same token', () => {
    const dir = dataDir()
    const store = createAuthSessionStore({ dataDir: dir, ttlMs: TTL })
    store.save('same', session)
    store.save('same', { ...session, lastSeenAt: 5_000 })
    expect(store.load(6_000)).toHaveLength(1)
    expect(store.load(6_000)[0].session.lastSeenAt).toBe(5_000)
    store.close()
  })
})

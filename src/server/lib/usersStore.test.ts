import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { scryptSync } from 'crypto'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createUsersStore, UserStoreError, validatePassword, validateRole, validateUsername, type UsersStore } from './usersStore.js'

let dir: string
let store: UsersStore

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'allison-users-'))
  store = createUsersStore({ dataDir: dir })
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('usersStore', () => {
  it('starts empty so first launch can trigger the setup flow', () => {
    expect(store.hasUsers()).toBe(false)
    expect(store.listUsers()).toEqual([])
  })

  it('creates an admin, verifies the password, and lists it without exposing hashes', () => {
    const created = store.createUser({ username: 'owner', password: 'supersecret', role: 'admin' })

    expect(created).toMatchObject({ username: 'owner', role: 'admin' })
    expect(store.hasUsers()).toBe(true)
    expect(store.verifyCredentials('owner', 'supersecret')?.username).toBe('owner')
    expect(store.verifyCredentials('owner', 'wrong-password')).toBeNull()
    expect(store.verifyCredentials('nobody', 'supersecret')).toBeNull()

    const persisted = readFileSync(join(dir, 'allison.db'), 'latin1')
    expect(persisted).not.toContain('supersecret')
    expect(JSON.stringify(store.listUsers())).not.toContain('hash')
  })

  it('survives a reload from disk (accounts persist across restarts)', () => {
    store.createUser({ username: 'alice', password: 'alicepass', role: 'user' })
    const reloaded = createUsersStore({ dataDir: dir })

    expect(reloaded.hasUsers()).toBe(true)
    expect(reloaded.verifyCredentials('alice', 'alicepass')?.role).toBe('user')
  })

  it('rejects duplicate usernames', () => {
    store.createUser({ username: 'alice', password: 'alicepass', role: 'user' })
    expect(() => store.createUser({ username: 'alice', password: 'otherpass', role: 'user' })).toThrow(UserStoreError)
  })

  it('deletes a user but refuses to remove the last admin', () => {
    store.createUser({ username: 'owner', password: 'supersecret', role: 'admin' })
    store.createUser({ username: 'alice', password: 'alicepass', role: 'user' })

    expect(store.deleteUser('alice')).toMatchObject({ username: 'alice' })
    expect(store.findUser('alice')).toBeNull()
    expect(() => store.deleteUser('owner')).toThrow(/last remaining admin/i)
    expect(store.countAdmins()).toBe(1)
  })

  it('records the last login timestamp', () => {
    store.createUser({ username: 'alice', password: 'alicepass', role: 'user' })
    expect(store.findUser('alice')?.lastLoginAt).toBeNull()

    store.recordLogin('alice')
    expect(store.findUser('alice')?.lastLoginAt).toBeTruthy()
  })

  it('stores and clears an account\u2019s encrypted IPTV credentials', () => {
    store.createUser({ username: 'alice', password: 'alicepass', role: 'user' })
    expect(store.getIptvCredentials('alice')).toBeNull()

    store.setIptvCredentials('alice', '{"version":1,"payload":"opaque"}')
    expect(store.getIptvCredentials('alice')).toBe('{"version":1,"payload":"opaque"}')

    store.setIptvCredentials('alice', null)
    expect(store.getIptvCredentials('alice')).toBeNull()
  })

  it('reports an unusable database instead of crashing, and healthCheck says so', () => {
    // Same posture as before the SQLite move: a damaged store yields a readable error from every
    // method (and a failed healthCheck) rather than taking the server down at boot. Uses its own
    // directory — writing garbage over a database that a live connection still has open in WAL
    // mode is recoverable, so it would not exercise this path.
    const brokenDir = mkdtempSync(join(tmpdir(), 'allison-broken-'))
    writeFileSync(join(brokenDir, 'allison.db'), 'this is not a database')
    const broken = createUsersStore({ dataDir: brokenDir })
    expect(() => broken.hasUsers()).toThrow(/not usable/i)
    const health = broken.healthCheck()
    expect(health.ok).toBe(false)
    if (!health.ok) expect(health.error.length).toBeGreaterThan(0)
    rmSync(brokenDir, { recursive: true, force: true })
  })

  it('healthCheck is ok on a clean store', () => {
    expect(store.healthCheck()).toEqual({ ok: true })
  })

  it('validates usernames, passwords and roles up front', () => {
    expect(validateUsername('ok-name.1')).toBe('ok-name.1')
    expect(() => validateUsername('ab')).toThrow(/3-32 characters/)
    expect(() => validateUsername('has space')).toThrow(/3-32 characters/)
    expect(() => validatePassword('short')).toThrow(/at least 6 characters/)
    expect(() => validateRole('superadmin')).toThrow(/"admin" or "user"/)
  })

  it('replaces a password, invalidating the old one', () => {
    store.createUser({ username: 'alice', password: 'alicepass', role: 'user' })

    store.setPassword('alice', 'brand-new-pass')

    expect(store.verifyCredentials('alice', 'brand-new-pass')?.username).toBe('alice')
    expect(store.verifyCredentials('alice', 'alicepass')).toBeNull()
  })

  it('persists a password change across a reload, and validates the new password', () => {
    store.createUser({ username: 'alice', password: 'alicepass', role: 'user' })
    store.setPassword('alice', 'newpassword1')

    const reloaded = createUsersStore({ dataDir: dir })
    expect(reloaded.verifyCredentials('alice', 'newpassword1')?.username).toBe('alice')

    expect(() => store.setPassword('alice', 'short')).toThrow(/at least 6 characters/)
    expect(() => store.setPassword('nobody', 'longenough')).toThrow(/does not exist/)
    // A rejected change must leave the previous password working.
    expect(store.verifyCredentials('alice', 'newpassword1')?.username).toBe('alice')
  })

  it('imports accounts from a pre-SQLite users.json, keeping the original file', () => {
    const flatDir = mkdtempSync(join(tmpdir(), 'allison-flat-'))
    const salt = 'aabbccdd'
    const hash = scryptSync('legacypass', salt, 64).toString('hex')
    writeFileSync(
      join(flatDir, 'users.json'),
      JSON.stringify({
        version: 1,
        users: [
          {
            username: 'legacy',
            role: 'admin',
            createdAt: '2026-01-01T00:00:00.000Z',
            lastLoginAt: null,
            password: { salt, hash },
            iptvCredentials: '{"version":1,"payload":"opaque"}'
          }
        ]
      })
    )

    const migrated = createUsersStore({ dataDir: flatDir })
    expect(migrated.hasUsers()).toBe(true)
    expect(migrated.verifyCredentials('legacy', 'legacypass')?.username).toBe('legacy')
    expect(migrated.findUser('legacy')?.role).toBe('admin')
    // The encrypted credentials blob and the original file both survive the move.
    expect(migrated.getIptvCredentials('legacy')).toBe('{"version":1,"payload":"opaque"}')
    expect(existsSync(join(flatDir, 'users.json.imported'))).toBe(true)

    // Re-opening must not import twice or lose anything.
    const reopened = createUsersStore({ dataDir: flatDir })
    expect(reopened.listUsers()).toHaveLength(1)
    rmSync(flatDir, { recursive: true, force: true })
  })
})

describe('usersStore.status', () => {
  it('reports a healthy database without performing a write', () => {
    expect(store.status()).toEqual({ ok: true })
  })

  it('reports the reason when the database cannot be opened at all', () => {
    // A data directory that is actually a file: openDatabase fails and the store holds no handle,
    // which is the state a deployment lands in when its volume is unwritable — the case where
    // every account operation 500s while /api/health still answers.
    const notADirectory = join(dir, 'this-is-a-file')
    writeFileSync(notADirectory, 'not a directory')
    const broken = createUsersStore({ dataDir: notADirectory })
    const status = broken.status()
    expect(status.ok).toBe(false)
    expect(status.error).toBeTruthy()
  })

  it('reports a usable handle as ok even with no accounts yet', () => {
    const fresh = createUsersStore({ dataDir: mkdtempSync(join(tmpdir(), 'allison-empty-')) })
    expect(fresh.status().ok).toBe(true)
    expect(fresh.hasUsers()).toBe(false)
  })
})

describe('storage failures are distinguishable from bad requests', () => {
  it('flags an unusable database so routes can answer 5xx rather than 4xx', () => {
    const notADirectory = join(dir, 'file-not-dir')
    writeFileSync(notADirectory, 'x')
    const broken = createUsersStore({ dataDir: notADirectory })
    try {
      broken.createUser({ username: 'someone', password: 'longenough', role: 'admin' })
      throw new Error('expected createUser to throw')
    } catch (err) {
      expect(err).toBeInstanceOf(UserStoreError)
      expect((err as UserStoreError).storageUnavailable).toBe(true)
    }
  })

  it('does not flag ordinary validation-level failures', () => {
    try {
      store.createUser({ username: 'nope!', password: 'longenough', role: 'admin' })
      throw new Error('expected createUser to throw')
    } catch (err) {
      expect((err as UserStoreError).storageUnavailable).toBe(false)
    }
  })
})

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createUsersStore, UserStoreError, validatePassword, validateRole, validateUsername, type UsersStore } from './usersStore.js'

let dir: string
let store: UsersStore

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'allison-users-'))
  store = createUsersStore({ filePath: join(dir, 'users.json') })
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

    const persisted = readFileSync(join(dir, 'users.json'), 'utf8')
    expect(persisted).not.toContain('supersecret')
    expect(JSON.stringify(store.listUsers())).not.toContain('hash')
  })

  it('survives a reload from disk (accounts persist across restarts)', () => {
    store.createUser({ username: 'alice', password: 'alicepass', role: 'user' })
    const reloaded = createUsersStore({ filePath: join(dir, 'users.json') })

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

  it('fails loudly but diagnostically when the users file is corrupted, and healthCheck reports it', () => {
    writeFileSync(join(dir, 'users.json'), '')
    expect(() => store.hasUsers()).toThrow(/corrupted/)
    const health = store.healthCheck()
    expect(health.ok).toBe(false)
    if (!health.ok) expect(health.error).toMatch(/corrupted/i)
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
})

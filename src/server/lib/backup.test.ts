import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { applyPendingRestore, backupDatabase, dailyBackup, listBackups, pendingRestorePath, validateDatabaseFile } from './backup.js'
import { createUsersStore } from './usersStore.js'

let dir: string

function createDatabase(withUser: boolean): string {
  const store = createUsersStore({ dataDir: dir })
  if (withUser) store.createUser({ username: 'owner', password: 'password1', role: 'admin' })
  return join(dir, 'allison.db')
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'allison-backup-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('backup & restore', () => {
  it('accepts a real database and rejects anything else', async () => {
    createDatabase(true)
    const copy = join(dir, 'copy.db')
    await backupDatabase(dir, copy)
    expect(validateDatabaseFile(copy)).toEqual({ ok: true })

    const junk = join(dir, 'junk.db')
    writeFileSync(junk, 'definitely not a database')
    expect(validateDatabaseFile(junk).ok).toBe(false)

    // A database without our schema is refused too — it would replace accounts with nothing.
    const foreign = join(dir, 'foreign.db')
    const db = new Database(foreign)
    db.exec('CREATE TABLE unrelated (x INTEGER)')
    db.close()
    expect(validateDatabaseFile(foreign).ok).toBe(false)
  })

  it('produces a copy that carries the accounts', async () => {
    createDatabase(true)
    const copy = join(dir, 'copy.db')
    await backupDatabase(dir, copy)

    const check = new Database(copy, { readonly: true })
    const users = check.prepare('SELECT username FROM users').all() as Array<{ username: string }>
    check.close()
    expect(users.map((user) => user.username)).toEqual(['owner'])
  })

  it('snapshots once a day, keeps a handful, and reports the newest', () => {
    createDatabase(true)
    const first = dailyBackup(dir)
    expect(first.created).toBe(true)
    expect(existsSync(first.path ?? '')).toBe(true)

    // A second call the same day is a no-op.
    expect(dailyBackup(dir).created).toBe(false)
    expect(listBackups(dir).length).toBe(1)
  })

  it('applies a staged restore on the next start, preserving the replaced database', async () => {
    createDatabase(true)
    // Build a "restored" database that has a different account.
    const staging = mkdtempSync(join(tmpdir(), 'allison-restore-'))
    const other = createUsersStore({ dataDir: staging })
    other.createUser({ username: 'restored-user', password: 'password2', role: 'admin' })

    // Stage it the way a real upload arrives: a consistent backup copy, not a raw file read (a
    // live WAL database's file alone can miss recently committed rows).
    const restored = join(staging, 'allison-restore.db')
    await backupDatabase(staging, restored)
    writeFileSync(pendingRestorePath(dir), readFileSync(restored))

    const outcome = applyPendingRestore(dir)
    expect(outcome.applied).toBe(true)

    const store = createUsersStore({ dataDir: dir })
    expect(store.findUser('restored-user')?.username).toBe('restored-user')
    expect(store.findUser('owner')).toBeNull()
    // The database that was replaced is kept, so a restore is itself undoable.
    expect(readdirSync(join(dir, 'backups')).some((name) => name.startsWith('allison-replaced-'))).toBe(true)
    rmSync(staging, { recursive: true, force: true })
  })

  it('discards an unusable pending restore instead of applying it', () => {
    createDatabase(true)
    writeFileSync(pendingRestorePath(dir), 'garbage')

    const outcome = applyPendingRestore(dir)
    expect(outcome.applied).toBe(false)
    expect(outcome.message).toMatch(/invalid/i)
    expect(existsSync(pendingRestorePath(dir))).toBe(false)
    expect(createUsersStore({ dataDir: dir }).findUser('owner')?.username).toBe('owner')
  })

  it('does nothing when there is no pending restore', () => {
    createDatabase(true)
    expect(applyPendingRestore(dir).applied).toBe(false)
  })
})

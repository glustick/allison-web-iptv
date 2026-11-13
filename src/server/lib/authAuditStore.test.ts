import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AUTH_AUDIT_LIMIT, createAuthAuditStore } from './authAuditStore.js'
import { createAuthAudit } from './authAudit.js'
import { openDatabase } from './db.js'

const dirs: string[] = []
/** A fresh data directory, which is also what a restart looks like from the store's point of view. */
function dataDir() {
  const dir = mkdtempSync(join(tmpdir(), 'audit-store-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true })
})

const entry = { username: 'autoclaw', ip: '10.0.0.5', userAgent: 'Safari' }

describe('createAuthAuditStore', () => {
  it('survives the thing it audits: entries outlive the audit object', () => {
    const dir = dataDir()
    createAuthAudit(200, createAuthAuditStore({ dataDir: dir })).record({ ...entry, outcome: 'ok' })
    // A fresh audit over the same database — as after a restart — still sees the entry.
    const afterRestart = createAuthAudit(200, createAuthAuditStore({ dataDir: dir }))
    const recent = afterRestart.recent(10)
    expect(recent).toHaveLength(1)
    expect(recent[0]).toMatchObject({ outcome: 'ok', username: 'autoclaw', ip: '10.0.0.5' })
  })

  it('reads newest first', () => {
    const dir = dataDir()
    const audit = createAuthAudit(200, createAuthAuditStore({ dataDir: dir }))
    audit.record({ ...entry, outcome: 'failed' })
    audit.record({ ...entry, outcome: 'ok' })
    expect(audit.recent(10).map((e) => e.outcome)).toEqual(['ok', 'failed'])
  })

  it('bounds the table instead of growing forever', () => {
    const dir = dataDir()
    const store = createAuthAuditStore({ dataDir: dir })
    for (let i = 0; i < AUTH_AUDIT_LIMIT + 25; i += 1) {
      store.append({ at: new Date(2026, 8, 16, 12, 0, i % 60).toISOString(), outcome: 'ok', username: `u${i}`, ip: '10.0.0.5', userAgent: 'x' })
    }
    const rows = openDatabase(dir).db.prepare('SELECT COUNT(*) AS count FROM auth_audit').get() as { count: number }
    expect(rows.count).toBe(AUTH_AUDIT_LIMIT)
    expect(store.recent(1)[0].username).toBe(`u${AUTH_AUDIT_LIMIT + 24}`)
  })
})

describe('recentFiltered (v0.102.0)', () => {
  it('filters by account, case-insensitively, through the durable store', () => {
    const dir = dataDir()
    const audit = createAuthAudit(200, createAuthAuditStore({ dataDir: dir }))
    audit.record({ username: 'chris', ip: '1.1.1.1', userAgent: 'Safari', outcome: 'ok' })
    audit.record({ username: 'Chris', ip: '1.1.1.1', userAgent: 'Safari', outcome: 'failed' })
    audit.record({ username: 'sam', ip: '1.1.1.1', userAgent: 'Safari', outcome: 'ok' })
    const rows = audit.recentFiltered({ username: 'CHRIS', limit: 10 })
    expect(rows).toHaveLength(2)
    expect(rows.every((row) => row.username.toLowerCase() === 'chris')).toBe(true)
  })

  it('filters by outcome alone', () => {
    const dir = dataDir()
    const audit = createAuthAudit(200, createAuthAuditStore({ dataDir: dir }))
    audit.record({ ...entry, outcome: 'ok' })
    audit.record({ ...entry, outcome: 'failed' })
    audit.record({ ...entry, outcome: 'ok' })
    expect(audit.recentFiltered({ outcome: 'failed', limit: 10 }).map((r) => r.outcome)).toEqual(['failed'])
  })

  it('composes account and outcome', () => {
    const dir = dataDir()
    const audit = createAuthAudit(200, createAuthAuditStore({ dataDir: dir }))
    audit.record({ username: 'chris', ip: '1', userAgent: 'ua', outcome: 'ok' })
    audit.record({ username: 'chris', ip: '1', userAgent: 'ua', outcome: 'failed' })
    audit.record({ username: 'sam', ip: '1', userAgent: 'ua', outcome: 'failed' })
    const rows = audit.recentFiltered({ username: 'chris', outcome: 'failed', limit: 10 })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ username: 'chris', outcome: 'failed' })
  })

  it('an empty filter is the unfiltered log', () => {
    const dir = dataDir()
    const audit = createAuthAudit(200, createAuthAuditStore({ dataDir: dir }))
    audit.record({ ...entry, outcome: 'ok' })
    audit.record({ ...entry, outcome: 'failed' })
    expect(audit.recentFiltered({ limit: 10 })).toHaveLength(2)
  })
})

describe('createAuthAudit.recentFiltered without a store (the ring)', () => {
  it('filters the in-memory ring by both sides', () => {
    const audit = createAuthAudit()
    audit.record({ username: 'chris', ip: '1', userAgent: 'ua', outcome: 'ok' })
    audit.record({ username: 'sam', ip: '1', userAgent: 'ua', outcome: 'ok' })
    audit.record({ username: 'chris', ip: '1', userAgent: 'ua', outcome: 'logout' })
    expect(audit.recentFiltered({ username: 'chris', limit: 10 })).toHaveLength(2)
    expect(audit.recentFiltered({ outcome: 'logout', limit: 10 })).toHaveLength(1)
    expect(audit.recentFiltered({ username: 'sam', outcome: 'logout', limit: 10 })).toHaveLength(0)
  })
})

import { describe, expect, it } from 'vitest'
import { createAuthAudit } from './authAudit.js'

const base = { username: 'autoclaw', ip: '192.168.0.9', userAgent: 'Safari' }

describe('createAuthAudit', () => {
  it('keeps the newest entries and reports them newest first', () => {
    const audit = createAuthAudit()
    audit.record({ ...base, outcome: 'failed' })
    audit.record({ ...base, outcome: 'ok' })
    const recent = audit.recent()
    expect(recent[0].outcome).toBe('ok')
    expect(recent[1].outcome).toBe('failed')
    expect(recent[0].at).toMatch(/T.*Z$/)
  })

  it('bounds the window instead of growing forever', () => {
    const audit = createAuthAudit(3)
    for (let i = 0; i < 10; i += 1) audit.record({ ...base, outcome: 'ok', username: `u${i}` })
    const recent = audit.recent(50)
    expect(recent).toHaveLength(3)
    expect(recent.map((e) => e.username)).toEqual(['u9', 'u8', 'u7'])
  })

  it('truncates a silly user-agent rather than storing it whole', () => {
    const audit = createAuthAudit()
    audit.record({ ...base, outcome: 'ok', userAgent: 'x'.repeat(5000) })
    expect(audit.recent()[0].userAgent.length).toBe(200)
  })

  it('asks for a sane number even when asked for none', () => {
    const audit = createAuthAudit()
    audit.record({ ...base, outcome: 'ok' })
    expect(audit.recent(0)).toHaveLength(1)
  })
})

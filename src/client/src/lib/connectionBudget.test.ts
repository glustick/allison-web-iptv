import { describe, expect, it } from 'vitest'
import { CONNECTION_CEILING, accountTileUsage, connectionStatus, tileGate, tileWouldExceed } from './connectionBudget'

describe('connectionStatus', () => {
  it('falls back to the standing hint while the live count is unknown', () => {
    const status = connectionStatus(null)
    expect(status.level).toBe('ok')
    expect(status.text).toContain('about 2')
    expect(status.text).toContain('may starve')
  })

  it('reports room below the ceiling', () => {
    const status = connectionStatus({ used: 1, streamCount: 1, transcodes: 0 })
    expect(status.level).toBe('ok')
    expect(status.text).toBe('1 live connection in use — room for another tile.')
  })

  it('pluralises', () => {
    const status = connectionStatus({ used: 0, streamCount: 0, transcodes: 0 })
    expect(status.text).toBe('0 live connections in use — room for another tile.')
  })

  it('names the ceiling exactly at it', () => {
    const status = connectionStatus({ used: 2, streamCount: 2, transcodes: 0 })
    expect(status.level).toBe('at')
    expect(status.text).toBe(
      "2 live connections in use — at the provider's limit of about 2; another tile may starve."
    )
  })

  it('warns over the ceiling, counting transcode sessions too', () => {
    const status = connectionStatus({ used: 3, streamCount: 1, transcodes: 2 })
    expect(status.level).toBe('over')
    expect(status.text).toContain("over the provider's limit of about 2")
    expect(status.text).toContain('starving now')
  })

  it('honours a different ceiling when passed', () => {
    expect(connectionStatus({ used: 2, streamCount: 2, transcodes: 0 }, 4).level).toBe('ok')
    expect(connectionStatus({ used: 4, streamCount: 4, transcodes: 0 }, 4).level).toBe('at')
  })
})

describe('tileWouldExceed', () => {
  it('is false while unknown or below the ceiling, true at and past it', () => {
    expect(tileWouldExceed(null)).toBe(false)
    expect(tileWouldExceed({ used: CONNECTION_CEILING - 1, streamCount: 1, transcodes: 0 })).toBe(false)
    expect(tileWouldExceed({ used: CONNECTION_CEILING, streamCount: 2, transcodes: 0 })).toBe(true)
    expect(tileWouldExceed({ used: CONNECTION_CEILING + 1, streamCount: 2, transcodes: 1 })).toBe(true)
  })
})

describe('connectionStatus with a known provider ceiling (v0.86.0)', () => {
  it('states a known number exactly — no "about" — including with no live count yet', () => {
    expect(connectionStatus(null, 3).text).toBe(
      'Each tile is a live connection — this account allows 3 concurrent streams.'
    )
    const at = connectionStatus({ used: 3, streamCount: 3, transcodes: 0 }, 3)
    expect(at.level).toBe('at')
    expect(at.text).toBe("3 live connections in use — at the provider's limit of 3; another tile may starve.")
    const over = connectionStatus({ used: 4, streamCount: 4, transcodes: 0 }, 3)
    expect(over.level).toBe('over')
    expect(over.text).toContain("over the provider's limit of 3")
  })
})

describe('tileGate (v0.86.0)', () => {
  const full = { used: 4, streamCount: 4, transcodes: 0 }
  const quiet = { used: 1, streamCount: 1, transcodes: 0 }

  it('blocks only on the account’s own KNOWN limit — the number came from the provider', () => {
    expect(tileGate(2, 2, full)).toBe('block')
    expect(tileGate(3, 2, full)).toBe('block')
    expect(tileGate(1, 2, full)).toBe('ok')
  })

  it('warns (never blocks) when the limit is unknown but the global fallback is spent', () => {
    expect(tileGate(2, null, full)).toBe('warn')
    expect(tileGate(9, null, full)).toBe('warn')
    expect(tileGate(1, null, quiet)).toBe('ok')
  })

  it('a known limit outranks the unknown-fallback warning', () => {
    // Global snapshot is spent, but this account has a known limit with room: adding is fine.
    expect(tileGate(1, 3, full)).toBe('ok')
  })
})

describe('accountTileUsage (v0.86.0)', () => {
  const slots = [
    { streamId: 1, name: 'A' }, // primary
    { streamId: 2, name: 'B', playlistId: 'p2' },
    { streamId: 3, name: 'C' }, // primary
    null
  ]

  it('counts only the tiles of one account, undefined meaning the primary', () => {
    expect(accountTileUsage(slots)).toBe(2)
    expect(accountTileUsage(slots, 'p2')).toBe(1)
    expect(accountTileUsage(slots, 'other')).toBe(0)
    expect(accountTileUsage([], undefined)).toBe(0)
  })
})
